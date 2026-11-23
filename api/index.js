"use strict";
/*
 * Vercel serverless entry: every /api/* request is rewritten here (vercel.json) and handled by the
 * same code as the local server. Static files come straight from /public.
 * Needs TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the Vercel project's environment variables.
 */
const { handler } = require("../server/server");

module.exports = (req, res) => {
  // the rewrite passes the original sub-path as ?__path=… in case req.url arrives as plain /api
  const u = new URL(req.url, "http://x");
  const sub = u.searchParams.get("__path");
  if (!u.pathname.startsWith("/api/") && sub != null) {
    u.searchParams.delete("__path");
    req.url = "/api/" + sub + (u.search || "");
  }
  return handler(req, res);
};
