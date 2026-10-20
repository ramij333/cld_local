const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = 8080;
const BASE = __dirname;
const ARIA2 = path.join(BASE, "aria2c.exe");
const DOWNLOAD_DIR = "E:\\Downloads";
//const DOWNLOAD_DIR = "D:\\IDM";
const SESSION = path.join(BASE, "aria2.session");
const RPC_PORT = 6800;
const RPC_SECRET = crypto.randomBytes(32).toString("hex");

app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(BASE, "public")));
app.use("/files", express.static(DOWNLOAD_DIR)); 

// Fallback catch-all route to serve your index.html explicitly

app.get("/", (req, res) => {
  res.sendFile(path.join(BASE, "public", "index.html"));
});


let aria2;
let rpcId = 0;

function rpc(method, params = []) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: String(++rpcId),
      method,
      params: [`token:${RPC_SECRET}`, ...params],
    });

    const req = require("http").request({
      hostname: "127.0.0.1",
      port: RPC_PORT,
      path: "/jsonrpc",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.error) {
            reject(new Error(parsed.error.message));
          } else {
            resolve(parsed.result);
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("timeout", () => req.destroy(new Error("aria2 RPC timed out")));
    req.on("error", reject);
    req.end(body);
  });
}


function validateLink(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 8192) {
    throw new Error("Please enter a valid link.");
  }
  const link = input.trim();
  if (/^magnet:\?/i.test(link)) {
    if (!/xt=urn:(btih|btmh):/i.test(link)) {
      throw new Error("This magnet link has no recognized torrent hash.");
    }
    return link;
  }
  let url;
  try { url = new URL(link); } catch {
    throw new Error("Enter a valid HTTP or HTTPS URL, or a magnet link.");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    throw new Error("Localhost URLs are not supported.");
  }
  return link;
}

async function getMergedDownloads() {
  const keys = [
    "gid", "status", "totalLength", "completedLength",
    "downloadSpeed", "files", "bittorrent", "errorMessage", "numSeeders"
  ];

  let ariaTasks = [];
  try {
    const [active, waiting, stopped] = await Promise.all([
      rpc("aria2.tellActive", [keys]),
      rpc("aria2.tellWaiting", [0, 100, keys]),
      rpc("aria2.tellStopped", [0, 100, keys]),
    ]);
    ariaTasks = [...active, ...waiting, ...stopped];
  } catch (err) {
    console.error("RPC Error fetching tasks:", err.message);
  }

  let diskFiles = [];
  if (fs.existsSync(DOWNLOAD_DIR)) {
    diskFiles = fs.readdirSync(DOWNLOAD_DIR);
  }

  const itemsMap = new Map();

  ariaTasks.forEach(item => {
    const total = Number(item.totalLength || 0);
    const done = Number(item.completedLength || 0);
    const files = item.files || [];
    const torrentName = item.bittorrent?.info?.name;
    
    let filePath = files[0]?.path;
    let fileName = filePath ? filePath.split(/[\\/]/).pop() : null;
    
    if (fileName && fileName.startsWith("[METADATA]")) fileName = null;
    const finalName = torrentName || fileName || "Downloading...";
    let diskKey = torrentName || fileName;

    itemsMap.set(diskKey || item.gid, {
      gid: item.gid,
      name: finalName,
      status: item.status,
      total,
      done,
      speed: Number(item.downloadSpeed || 0),
      progress: total ? Math.round(done * 1000 / total) / 10 : 0,
      error: item.errorMessage || "",
      seeders: Number(item.numSeeders || 0),
      onDisk: diskKey ? diskFiles.includes(diskKey) : false
    });
  });

  diskFiles.forEach(file => {
    if (file.endsWith(".aria2") || file === "aria2.session") return;
    if (!itemsMap.has(file)) {
      try {
        const stat = fs.statSync(path.join(DOWNLOAD_DIR, file));
        itemsMap.set(file, {
          gid: "completed_" + Buffer.from(file).toString("hex").slice(0, 12),
          name: file,
          status: "complete",
          total: stat.size,
          done: stat.size,
          speed: 0,
          progress: 100,
          error: "",
          seeders: 0,
          onDisk: true
        });
      } catch (e) {}
    }
  });

  return Array.from(itemsMap.values());
}


app.post("/api/add", async (req, res) => {
  try {
    const link = validateLink(req.body?.url);
    const gid = await rpc("aria2.addUri", [[link], { dir: DOWNLOAD_DIR, continue: "true" }]);
    res.json({ gid, message: "Download added." });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});



app.post("/api/torrent", express.raw({ type: "application/x-bittorrent", limit: "10mb" }), async (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) {
      return res.status(400).json({ error: "Upload a valid .torrent file." });
    }
    const encoded = req.body.toString("base64");
    const gid = await rpc("aria2.addTorrent", [encoded, [], { dir: DOWNLOAD_DIR }]);
    res.json({ gid, message: "Torrent added." });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get("/api/downloads", async (req, res) => {
  try {
    const list = await getMergedDownloads();
    res.json({ downloads: list, folder: DOWNLOAD_DIR });
  } catch (e) {
    res.status(503).json({ error: "Storage sync error: " + e.message });
  }
});

app.post("/api/action", async (req, res) => {
  const { gid, action, name } = req.body || {};

  if (typeof gid !== "string" || !gid.trim()) {
    return res.status(400).json({ error: "Invalid ID." });
  }

  const methods = {
    pause: "aria2.pause",
    resume: "aria2.unpause",
    remove: "aria2.forceRemove"
  };

  if (!methods[action]) {
    return res.status(400).json({ error: "Unknown action style." });
  }

  try {
    // 1. Process aria2 task adjustments cleanly if it isn't an archive item
    if (!gid.startsWith("completed_")) {
      try { 
        await rpc(methods[action], [gid]); 
      } catch (e) {
        if (action === "remove") {
          try { await rpc("aria2.removeDownloadResult", [gid]); } catch (err) {}
        }
      }
    }

    // 2. Wipes physical file allocations if action target is explicitly "remove"
    if (action === "remove" && name) {
      const targetPath = path.resolve(DOWNLOAD_DIR, name);
      const metaControlPath = targetPath + ".aria2";

      if (targetPath.startsWith(DOWNLOAD_DIR)) {
        if (fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
        if (fs.existsSync(metaControlPath)) {
          fs.rmSync(metaControlPath, { force: true });
        }
      }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});


async function main() {
  if (!fs.existsSync(ARIA2)) {
    throw new Error("aria2c.exe is missing from " + BASE);
  }

  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  if (!fs.existsSync(SESSION)) fs.writeFileSync(SESSION, "");

  aria2 = spawn(ARIA2, [
    "--enable-rpc=true",
    "--rpc-listen-all=false",
    `--rpc-listen-port=${RPC_PORT}`,
    `--rpc-secret=${RPC_SECRET}`,
    `--dir=${DOWNLOAD_DIR}`,
    "--continue=true",
    "--max-tries=0",               
    "--retry-wait=5",              
    "--timeout=30",                
    "--file-allocation=none",
    "--max-concurrent-downloads=5",
    "--max-connection-per-server=8",
    "--split=8",
    "--min-split-size=1M",
    "--follow-torrent=true",
    "--seed-time=0",
    "--bt-save-metadata=true",
    `--input-file=${SESSION}`,
    `--save-session=${SESSION}`,
    "--save-session-interval=30",
    "--auto-save-interval=30",
    "--summary-interval=0",
    "--console-log-level=warn",
  ], {
    cwd: BASE,
    windowsHide: true,
    stdio: "ignore",
  });

  aria2.on("error", err => console.error("aria2 launch error:", err.message));
  aria2.on("exit", code => console.log("aria2 exited:", code));

  let ready = false;
  for (let i = 0; i < 40; i++) {
    if (aria2.exitCode !== null) throw new Error("aria2 exited during startup.");
    try {
      await rpc("aria2.getVersion");
      ready = true;
      break;
    } catch {
      await new Promise(r => setTimeout(r, 250));
    }
  }
  if (!ready) throw new Error("aria2 RPC did not start. Check port 6800.");

  app.listen(PORT, "127.0.0.1", () => {
    console.log(`SeedrLocal: http://127.0.0.1:${PORT}`);
    console.log(`Downloads: ${DOWNLOAD_DIR}`);
  });
}

main().catch(err => {
  console.error("Startup failed:", err.message);
  if (aria2 && aria2.exitCode === null) aria2.kill();
  process.exitCode = 1;
});
