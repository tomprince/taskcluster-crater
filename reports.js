'use strict';

var debug = require('debug')(__filename.slice(__dirname.length + 1));
var util = require('./crater-util');
var crateIndex = require('./crate-index');
var Promise = require('promise');
var db = require('./crater-db');
var assert = require('assert');
var dist = require('./rust-dist');

/**
 * Returns a promise of the data for a 'weekly report'.
 */
function createWeeklyReport(date, dbctx, rustDistAddr, indexAddr, cacheDir) {
  return createCurrentReport(date, rustDistAddr).then(function(currentReport) {
    return {
      currentReport: currentReport
    };
  }).then(function(state) {
    var stableToolchain = { channel: "stable", archiveDate: state.currentReport.stable };
    var betaToolchain = { channel: "beta", archiveDate: state.currentReport.beta };
    var nightlyToolchain = { channel: "nightly", archiveDate: state.currentReport.nightly };

    var betaStatuses = calculateStatuses(dbctx, stableToolchain, betaToolchain);
    var nightlyStatuses = calculateStatuses(dbctx, betaToolchain, nightlyToolchain);

    return Promise.all([betaStatuses, nightlyStatuses]).then(function(statuses) {
      return {
	currentReport: state.currentReport,
	betaStatuses: statuses[0],
	nightlyStatuses: statuses[1]
      };
    });
  }).then(function(state) {

    var betaStatusSummary = calculateStatusSummary(state.betaStatuses);
    var nightlyStatusSummary = calculateStatusSummary(state.nightlyStatuses);
    var betaRegressions = calculateRegressions(state.betaStatuses);
    var nightlyRegressions = calculateRegressions(state.nightlyStatuses);
    var betaRootRegressions = pruneDependentRegressions(betaRegressions, indexAddr, cacheDir);
    var nightlyRootRegressions = pruneDependentRegressions(nightlyRegressions, indexAddr, cacheDir);

    return Promise.all([betaRootRegressions, nightlyRootRegressions]).then(function(regs) {

      var betaRootRegressions = regs[0];
      var nightlyRootRegressions = regs[1];

      var betaNonRootRegressions = pruneRootRegressions(betaRegressions, betaRootRegressions);
      var nightlyNonRootRegressions = pruneRootRegressions(nightlyRegressions, nightlyRootRegressions);

      return {
	date: date,
	currentReport: state.currentReport,
	betaStatuses: state.betaStatuses,
	nightlyStatuses: state.nightlyStatuses,
	betaStatusSummary: betaStatusSummary,
	nightlyStatusSummary: nightlyStatusSummary,
	betaRegressions: betaRegressions,
	nightlyRegressions: nightlyRegressions,
	betaRootRegressions: betaRootRegressions,
	nightlyRootRegressions: nightlyRootRegressions,
	betaNonRootRegressions: betaNonRootRegressions,
	nightlyNonRootRegressions: nightlyNonRootRegressions
      };
    });
  });
}

/**
 * Returns promise of array of `{ crateName, crateVers, status }`,
 * where `status` is either 'working', 'not-working', 'regressed',
 * 'fixed'.
 */ 
function calculateStatuses(dbctx, fromToolchain, toToolchain) {

  if (fromToolchain.archiveDate == null || toToolchain.archiveDate == null) {
    return new Promise(function(resolve, reject) { resolve([]); });
  }

  return db.getResultPairs(dbctx, fromToolchain, toToolchain).then(function(buildResults) {
    return buildResults.map(function(buildResult) {
      var status = null;
      if (buildResult.from.success && buildResult.to.success) {
	status = "working";
      } else if (!buildResult.from.success && !buildResult.to.success) {
	status = "not-working";
      } else if (buildResult.from.success && !buildResult.to.success) {
	status = "regressed";
      } else {
	assert(!buildResult.from.success && buildResult.to.success);
	status = "fixed";
      }

      return {
	crateName: buildResult.crateName,
	crateVers: buildResult.crateVers,
	status: status
      };
    });
  });
}

function calculateStatusSummary(statuses) {
  var working = 0;
  var notWorking = 0;
  var regressed = 0;
  var fixed = 0;
  statuses.forEach(function(status) {
    if (status.status == "working") {
      working += 1;
    } else if (status.status == "not-working") {
      notWorking += 1;
    } else if (status.status == "regressed") {
      regressed += 1;
    } else {
      assert(status.status == "fixed");
      fixed += 1;
    }
  });

  return {
    working: working,
    notWorking: notWorking,
    regressed: regressed,
    fixed: fixed
  };
}

function calculateRegressions(statuses) {
  var regressions = [];
  statuses.forEach(function(status) {
    if (status.status == "regressed") {
      regressions.push(status);
    }
  });
  return regressions;
}

function pruneDependentRegressions(regressions, crates, indexAddr, cacheDir) {
  var regressionMap = {};
  regressions.forEach(function(r) {
    regressionMap[r.crateName] = r;
  });

  return crateIndex.loadCrates(indexAddr, cacheDir).then(function(crates) {
    var dag = crateIndex.getDag(crates);
    var independent = [];
    regressions.forEach(function(reg) {
      var isIndependent = true;
      var depStack = dag[reg.crateName];
      if (depStack == null) {
	// No info about this crate? Happens in the test suite.
	debug("no deps for " + reg.crateName);
      }
      while (depStack && depStack.length != 0 && isIndependent) {

	var nextDep = depStack.pop();
	if (regressionMap[nextDep]) {
	  debug(reg.crateName + " depends on regressed " + nextDep);
	  isIndependent = false;
	}

	if (dag[nextDep]) {
	  depStack.concat(dag[nextDep]);
	}
      }
      if (isIndependent) {
	debug(reg.crateName + " is an independent regression");
	independent.push(reg);
      }
    });
    return independent;
  });
}

function pruneRootRegressions(regs, rootRegs) {
  var rootRegMap = {};
  rootRegs.forEach(function(r) {
    rootRegMap[r.crateName] = r;
  });

  var dependent = []
  regs.forEach(function(reg) {
    if (!rootRegMap[reg.crateName]) {
      dependent.push(reg);
    }
  });

  return dependent;
}

/**
 * Returns a promise of a report on the current nightly/beta/stable revisions.
 */
function createCurrentReport(date, rustDistAddr) {
  return dist.getAvailableToolchains(rustDistAddr).then(function(toolchains) {
    var currentNightlyDate = null;
    toolchains.nightly.forEach(function(toolchainDate) {
      if (toolchainDate <= date) {
	currentNightlyDate = toolchainDate;
      }
    });
    var currentBetaDate = null;
    toolchains.beta.forEach(function(toolchainDate) {
      if (toolchainDate <= date) {
	currentBetaDate = toolchainDate;
      }
    });
    var currentStableDate = null;
    toolchains.stable.forEach(function(toolchainDate) {
      if (toolchainDate <= date) {
	currentStableDate = toolchainDate;
      }
    });

    return {
      nightly: currentNightlyDate,
      beta: currentBetaDate,
      stable: currentStableDate
    };

  });
}

exports.createWeeklyReport = createWeeklyReport
exports.createCurrentReport = createCurrentReport