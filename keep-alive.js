const http = require("http");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("PJA Bot is alive!");
});

server.listen(process.env.PORT || 3000, () => {
  console.log("Keep-alive server running on port " + (process.env.PORT || 3000));
});

