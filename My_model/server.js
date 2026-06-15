import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.dirname(fileURLToPath(import.meta.url));
const host = "127.0.0.1";
const preferredPort = Number(process.env.PORT || 8090);

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ndjson": "application/x-ndjson; charset=utf-8",
  ".png": "image/png",
};

function send(res, code, body, type = "text/plain; charset=utf-8") {
  res.writeHead(code, { "Content-Type": type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);

  if (req.method === "POST" && urlPath === "/api/export-charts") {
    handleChartExport(req, res);
    return;
  }

  if (req.method === "POST" && urlPath === "/api/log/start") {
    handleLogStart(req, res);
    return;
  }

  if (req.method === "POST" && urlPath === "/api/log/append") {
    handleLogAppend(req, res);
    return;
  }

  const safePath = path
    .normalize(urlPath === "/" ? "index.html" : urlPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const filePath = path.join(root, safePath);

  if (!filePath.startsWith(root)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, "Not found");
      return;
    }
    send(res, 200, data, types[path.extname(filePath)] || "application/octet-stream");
  });
});

function handleChartExport(req, res) {
  readJsonBody(req, 20_000_000, (error, payload) => {
    if (error) {
      send(res, 500, JSON.stringify({ error: error.message }), types[".json"]);
      return;
    }

    try {
      if (Array.isArray(payload.samples)) {
        exportChartsWithPython(payload, res);
        return;
      }

      const images = Array.isArray(payload.images) ? payload.images : [];
      if (!images.length) {
        send(res, 400, JSON.stringify({ error: "No images" }), types[".json"]);
        return;
      }

      const exportDir = path.join(root, "exports");
      fs.mkdirSync(exportDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const files = [];

      images.forEach((image, index) => {
        const dataUrl = String(image.dataUrl || "");
        const match = dataUrl.match(/^data:image\/png;base64,(.+)$/);
        if (!match) return;

        const safeName = String(image.name || `chart-${index + 1}`)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")
          .replace(/^-+|-+$/g, "");
        const name = `${stamp}-${safeName || `chart-${index + 1}`}.png`;
        const filePath = path.join(exportDir, name);
        fs.writeFileSync(filePath, Buffer.from(match[1], "base64"));
        files.push({ name, url: `/exports/${name}` });
      });

      send(res, 200, JSON.stringify({ files }), types[".json"]);
    } catch (error) {
      send(res, 500, JSON.stringify({ error: error.message }), types[".json"]);
    }
  });
}

function exportChartsWithPython(payload, res) {
  const samples = Array.isArray(payload.samples) ? payload.samples : [];
  if (!samples.length) {
    send(res, 400, JSON.stringify({ error: "No samples" }), types[".json"]);
    return;
  }

  const exportDir = path.join(root, "exports");
  fs.mkdirSync(exportDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scriptPath = path.join(root, "scripts", "render_charts.py");
  const python = spawn("python", [scriptPath, exportDir, stamp], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  const timeout = setTimeout(() => {
    python.kill();
  }, 60_000);

  python.stdout.setEncoding("utf8");
  python.stderr.setEncoding("utf8");
  python.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  python.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  python.on("error", (error) => {
    clearTimeout(timeout);
    send(res, 500, JSON.stringify({ error: `Python export failed: ${error.message}` }), types[".json"]);
  });

  python.on("close", (code) => {
    clearTimeout(timeout);
    if (code !== 0) {
      send(
        res,
        500,
        JSON.stringify({ error: stderr.trim() || `Python export failed with code ${code}` }),
        types[".json"],
      );
      return;
    }

    try {
      const result = JSON.parse(stdout || "{}");
      send(res, 200, JSON.stringify(result), types[".json"]);
    } catch (error) {
      send(
        res,
        500,
        JSON.stringify({ error: `Python export returned invalid JSON: ${error.message}` }),
        types[".json"],
      );
    }
  });

  python.stdin.end(JSON.stringify({ samples, summary: payload.summary ?? null }));
}

function handleLogStart(req, res) {
  readJsonBody(req, 2_000_000, (error, payload) => {
    if (error) {
      send(res, 500, JSON.stringify({ error: error.message }), types[".json"]);
      return;
    }

    try {
      const logDir = path.join(root, "logs");
      fs.mkdirSync(logDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const suffix = Math.random().toString(36).slice(2, 8);
      const name = `${stamp}-sim-${suffix}.ndjson`;
      const filePath = path.join(logDir, name);
      const firstLine = JSON.stringify({
        seq: 0,
        type: "log-file-created",
        wallTime: new Date().toISOString(),
        payload,
      });
      fs.writeFileSync(filePath, `${firstLine}\n`, "utf8");
      send(res, 200, JSON.stringify({ name, url: `/logs/${name}` }), types[".json"]);
    } catch (error) {
      send(res, 500, JSON.stringify({ error: error.message }), types[".json"]);
    }
  });
}

function handleLogAppend(req, res) {
  readJsonBody(req, 8_000_000, (error, payload) => {
    if (error) {
      send(res, 500, JSON.stringify({ error: error.message }), types[".json"]);
      return;
    }

    try {
      const name = safeLogName(payload.name);
      const events = Array.isArray(payload.events) ? payload.events : [];
      if (!name || !events.length) {
        send(res, 400, JSON.stringify({ error: "Missing log name or events" }), types[".json"]);
        return;
      }

      const logDir = path.join(root, "logs");
      const filePath = path.join(logDir, name);
      if (!filePath.startsWith(logDir)) {
        send(res, 403, JSON.stringify({ error: "Forbidden" }), types[".json"]);
        return;
      }

      const lines = events.map((event) => JSON.stringify(event)).join("\n");
      fs.appendFileSync(filePath, `${lines}\n`, "utf8");
      send(res, 200, JSON.stringify({ ok: true, appended: events.length }), types[".json"]);
    } catch (error) {
      send(res, 500, JSON.stringify({ error: error.message }), types[".json"]);
    }
  });
}

function readJsonBody(req, maxBytes, done) {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > maxBytes) req.destroy();
  });

  req.on("end", () => {
    try {
      done(null, body ? JSON.parse(body) : {});
    } catch (error) {
      done(error);
    }
  });
}

function safeLogName(name) {
  const value = String(name || "");
  return /^[a-z0-9-]+\.ndjson$/i.test(value) ? value : "";
}

function listen(port, attemptsLeft = 12) {
  server.once("error", (error) => {
    if ((error.code === "EACCES" || error.code === "EADDRINUSE") && attemptsLeft > 0) {
      const nextPort = port === 8080 ? 8090 : port + 1;
      console.warn(`Port ${port} unavailable (${error.code}), trying ${nextPort}...`);
      listen(nextPort, attemptsLeft - 1);
      return;
    }
    throw error;
  });

  server.listen(port, host, () => {
    console.log(`My_model simulator: http://${host}:${port}`);
  });
}

listen(preferredPort);
