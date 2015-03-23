/*
 * Stores and retrieves results from test runs.
 */

'use strict';

var debug = require('debug')(__filename.slice(__dirname.length + 1));
var Promise = require('promise');
var pg = require('pg');
var util = require('./crater-util');

/**
 * Connects to a PostgreSQL DB and returns a promise of an opaque type
 * accepted as context to other functions here.
 */
function connect(config) {
  var credentials = config.dbCredentials;
  var dbname = config.dbName;

  var dbctx = new Promise(function(resolve, reject) {
    var client = new pg.Client({
      user: credentials.username,
      password: credentials.password,
      database: dbname
    });

    client.connect(function(err) {
      if (!err) {
	resolve({ client: client });
      } else {
	reject(err);
      }
    });
  });
  return dbctx.then(function(dbctx) {
    var p = populate(dbctx);
    var p = p.then(function() { return dbctx; });
    return p;
  });
}

function disconnect(dbctx) {
  dbctx.client.end();
  return Promise.resolve();
}

/**
 * Creates the tables of a database return a promise of nothing. Taks
 * a promise of a database context created by `connect`.
 */
function populate(dbctx) {
  var q = "create table if not exists \
           build_results ( \
           toolchain text not null, \
           crate_name text not null, crate_vers text not null, \
           success boolean not null, \
           task_id text, \
           primary key ( \
           toolchain, crate_name, crate_vers ) ) \
           ";
  return new Promise(function (resolve, reject) {
    dbctx.client.query(q, function(e, r) {
      if (e) { reject(e); }
      else { resolve(r); }
    });
  });
}

/**
 * Destroys the tables.
 */
function depopulate(dbctx) {
  var q = "drop table if exists build_results";
  debug(q);
  return new Promise(function (resolve, reject) {
    dbctx.client.query(q, function(e, r) {
      if (e) { reject(e); }
      else { resolve(r); }
    });
  });
}

/**
 * Adds a build result and returns a promise of nothing. buildResult should
 * look like `{ toolchain: ..., crateName: ..., crateVers: ..., success: ...,
 * taskId: ... }`.
 */
function addBuildResult(dbctx, buildResult) {
  return new Promise(function (resolve, reject) {
    var f = function(e, r) {
      dbctx.client.query('commit', function(err, res) {
	if (e) { reject(e); }
	else { resolve(); }
      });
    };

    dbctx.client.query('begin', function(err, res) {
      if (err) {
	reject(err);
	return;
      }
      var p = getBuildResult(dbctx, buildResult);
      p.then(function(r) {
	if (r == null) {
	  var q = "insert into build_results values ($1, $2, $3, $4, $5)";
	  debug(q);
	  dbctx.client.query(q, [util.toolchainToString(buildResult.toolchain),
				 buildResult.crateName,
				 buildResult.crateVers,
				 buildResult.success,
				 buildResult.taskId],
			     f);
	} else {
	  var q = "update build_results set success = $4, task_id = $5 where \
                   toolchain = $1 and crate_name = $2 and crate_vers = $3";
	  debug(q);
	  dbctx.client.query(q, [util.toolchainToString(buildResult.toolchain),
				 buildResult.crateName,
				 buildResult.crateVers,
				 buildResult.success,
				 buildResult.taskId],
			     f);
	}
      }).catch(function(e) {
	reject(e);
      });
    });

  });
}

/**
 * Adds a build result and returns a promise of a build
 * result. buildResultKey should look like `{ toolchain: ...,
 * crateName: ..., crateVers: ... }`.
 *
 * Returns a promised null if there is no build result for the key.
 */
function getBuildResult(dbctx, buildResultKey) {
  var q = "select * from build_results where \
           toolchain = $1 and crate_name = $2 and crate_vers = $3";
  debug(q);
  return new Promise(function (resolve, reject) {
    var f = function(e, r) {
      if (e) { reject(e); }
      else {
	if (r.rows.length > 0) {
	  var row = r.rows[0];
	  resolve({
	    toolchain: util.parseToolchain(row.toolchain),
	    crateName: row.crate_name,
	    crateVers: row.crate_vers,
	    success: row.success,
	    taskId: row.task_id
	  });
	} else {
	  resolve(null);
	}
      }
    };

    dbctx.client.query(q, [util.toolchainToString(buildResultKey.toolchain),
			   buildResultKey.crateName,
			   buildResultKey.crateVers],
		       f);
  });
}

/**
 * Returns a promise of an array of pairs of build results for a given
 * pair of toolchains. Each element of the array looks like
 * `{ crateName: ..., crateVers: ..., from: ..., to: ... }`,
 * and `from` and `to` look like `{ succes: bool }`.
 */
function getResultPairs(dbctx, fromToolchain, toToolchain) {
  var q = "select a.crate_name, a.crate_vers, a.success as from_success, b.success as to_success, \
           a.task_id as from_task_id, b.task_id as to_task_id \
           from build_results a, build_results b \
           where a.toolchain = $1 and b.toolchain = $2 \
           and a.crate_name = b.crate_name and a.crate_vers = b.crate_vers \
           order by a.crate_name, a.crate_vers";
  debug(q);
  return new Promise(function(resolve, reject) {
    var f = function(e, r) {
      if (e) { reject(e); }
      else {
	var results = []
	r.rows.forEach(function(row) {
	  debug("result row: " + JSON.stringify(row));
	  results.push({
	    crateName: row.crate_name,
	    crateVers: row.crate_vers,
	    from: { success: row.from_success, taskId: row.from_task_id },
	    to: { success: row.to_success, taskId: row.to_task_id }
	  });
	});
	resolve(results);
      }
    };

    dbctx.client.query(q, [util.toolchainToString(fromToolchain),
			   util.toolchainToString(toToolchain)],
		       f);
  });
}

exports.connect = connect;
exports.disconnect = disconnect;
exports.populate = populate;
exports.depopulate = depopulate;
exports.addBuildResult = addBuildResult;
exports.getBuildResult = getBuildResult;
exports.getResultPairs = getResultPairs;
