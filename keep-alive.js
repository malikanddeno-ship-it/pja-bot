const http = require("http");

let onMatchReceived = null;

function setMatchHandler(fn) {
  onMatchReceived = fn;
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET") {
    res.writeHead(200);
    res.end("PJA Bot is alive!");
    return;
  }

  if (req.method === "POST" && req.url === "/match") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const data = JSON.parse(body);
        console.log("Match received from website:", data);
        if (onMatchReceived) {
          onMatchReceived(data);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Bot not ready yet" }));
        }
      } catch (e) {
        console.error("Invalid JSON from website:", e.message);
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
      }
    });
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

server.listen(process.env.PORT || 8080, () => {
  console.log("Keep-alive server running on port " + (process.env.PORT || 8080));
});

module.exports = { setMatchHandler };
