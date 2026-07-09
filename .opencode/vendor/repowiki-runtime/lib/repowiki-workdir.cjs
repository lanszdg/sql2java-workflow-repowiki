"use strict";

const path = require("path");

function repowikiWorkDir(repo) {
  return path.resolve(process.env.REPOWIKI_WORK_DIR || path.join(repo, ".repowiki"));
}

module.exports = { repowikiWorkDir };
