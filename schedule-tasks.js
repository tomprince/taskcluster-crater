'use strict';

var debug = require('debug')(__filename.slice(__dirname.length + 1));
var fs = require('fs');
var util = require('./crater-util');
var tc = require('taskcluster-client');
var Promise = require('promise');
var slugid = require('slugid');
var scheduler = require('./scheduler');
var crateIndex = require('./crate-index');
var db = require('./crater-db');

function main() {
  var options = parseOptionsFromArgs();
  if (!options) {
    console.log("can't parse options");
    process.exit(1);
  }

  debug("scheduling for toolchain %s", JSON.stringify(options));

  var config = util.loadDefaultConfig();

  crateIndex.updateCaches(config).then(function() {
    if (options.type == "crate-build") {
      db.connect(config).then(function(dbctx) {
	Promise.resolve().then(function() {
	  return scheduler.createSchedule(options, config, dbctx);
	}).then(function(schedule) {
	  return scheduler.scheduleBuilds(dbctx, schedule, config);
	}).then(function(tasks) {
	  console.log("created " + tasks.length + " tasks");
	}).then(function() {
	  db.disconnect(dbctx);
	}).catch(function(e) {
	  console.log("error: " + e);
	  db.disconnect(dbctx);
	}).done();
      });
    } else {
      Promise.resolve().then(function() {
	return scheduler.scheduleCustomBuild(options, config);
      }).catch(function(e) {
	console.log("error: " + e);
      }).done();
    }
  }).catch(function(e) {
    console.log("error: " + e);
  }).done();
}

function parseOptionsFromArgs() {
  var type = process.argv[2];
  if (type == "crate-build") {
    var toolchain = util.parseToolchain(process.argv[3])
    var top = null;
    var mostRecentOnly = false;
    var crateName = null;
    var skipExisting = false;
    for (var i = 4; i < process.argv.length; i++) {
      if (process.argv[i] == "--top") {
	top = parseInt(process.argv[i + 1]);
      }
      if (process.argv[i] == "--most-recent-only") {
	mostRecentOnly = true;
      }
      if (process.argv[i] == "--name") {
	crateName = process.argv[i + 1];
      } 
      if (process.argv[i] == "--skip-existing") {
	skipExisting = true;
      }
    }

    return {
      type: "crate-build",
      toolchain: toolchain,
      top: top,
      mostRecentOnly: mostRecentOnly,
      crateName: crateName,
      skipExisting: skipExisting
    };
  } else if (type == "custom-build") {
    var gitRepo = process.argv[3];
    var commitSha = process.argv[4];
    if (!gitRepo || !commitSha) {
      return null;
    }

    return {
      type: "custom-build",
      gitRepo: gitRepo,
      commitSha: commitSha
    };
  }
}

main();
