const { URL } = require("url");

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  const text = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(text);
}

function getPathname(request) {
  const url = new URL(request.url, "http://127.0.0.1");
  return url.pathname;
}

module.exports = {
  getPathname,
  readJson,
  sendJson,
};
