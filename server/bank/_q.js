"use strict";
/*
 * Compact question builder for the per-topic bank files in this folder.
 *   const q = require("./_q")("space");
 *   q(id, difficulty, text, hint, strip, explain, answers)
 * strip: space-separated words removed before matching (default "the").
 * answers: same format as questions.js — "Canonical|alias:weight;…", most common first.
 */
module.exports = topic => (id, difficulty, text, hint, strip, explain, answers) =>
  ({ id, topic, difficulty, text, hint, strip: (strip || "the").split(" ").filter(Boolean), explain, answers });
