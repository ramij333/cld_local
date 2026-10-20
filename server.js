
require("dotenv").config();

const bcrypt = require("bcryptjs");
const session = require("express-session");

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = 8080;
const BASE = __dirname;
const ARIA2 = path.join(BASE, "aria2c.exe");

const YTDLP = path.join(BASE, "yt-dlp.exe");
const socialJobs = new Map();

const DOWNLOAD_DIR = "E:\\Downloads";
//const DOWNLOAD_DIR = "D:\\IDM";
const SESSION = path.join(BASE, "aria2.session");
const RPC_PORT = 6800;
const RPC_SECRET = crypto.randomBytes(32).toString("hex");


const USERS_FILE = path.join(__dirname, "users.json");
const SESSION_SECRET = process.env.SESSION_SECRET;
const FFMPEG = path.join(BASE, "ffmpeg.exe");

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET is missing from .env");
}



// Initialize the users file if it doesn't exist.
if (!fs.existsSync(USERS_FILE)) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify({ users: [] }, null, 2),
    "utf8"
  );
}

function readUsers() {
  const data = JSON.parse(fs.readFileSync(USERS_FILE, "utf8"));

  if (!data || !Array.isArray(data.users)) {
    throw new Error("users.json has an invalid format");
  }

  return data.users;
}

function writeUsers(users) {
  fs.writeFileSync(
    USERS_FILE,
    JSON.stringify({ users }, null, 2),
    "utf8"
  );
}

app.use(express.json({ limit: "1mb" }));

app.use(session({
  name: "cloudlocal.sid",
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "strict",
    secure: false,
    maxAge: 8 * 60 * 60 * 1000
  }
}));


function requireAuth(req, res, next) {
  if (req.session?.userId) {
    return next();
  }

  if (req.originalUrl.startsWith("/api/")) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  return res.redirect("/login");
}

function requireAdmin(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({
      error: "Please log in first."
    });
  }

  try {
    if (!isAdminUser(req)) {
      return res.status(403).json({
        error: "Admin permission required."
      });
    }

    next();
  } catch (err) {
    console.error("Role verification failed:", err.message);
    res.status(500).json({
      error: "Unable to verify account permissions."
    });
  }
}

function isAdminUser(req) {
  const users = readUsers();
  const user = users.find(
    u => u.id === req.session?.userId
  );

  return user?.role === "admin";
}




// app.use(express.static(path.join(BASE, "public")));
// app.use("/files", express.static(DOWNLOAD_DIR)); 


// Fallback catch-all route to serve your index.html explicitly
// app.get("/", (req, res) => {
//   res.sendFile(path.join(BASE, "public", "index.html"));
// });

app.get("/login", (req, res) => {
  if (req.session?.userId) return res.redirect("/");
  res.sendFile(path.join(BASE, "public", "login.html"));
});

app.get("/register", (req, res, next) => {
  // Must be logged in first
  if (!req.session?.userId) {
    return res.redirect("/login");
  }

  try {
    // Only administrators can access the registration page
    if (!isAdminUser(req)) {
      return res.status(403).send("403 Forbidden: Admin permission required.");
    }

    return res.sendFile(
      path.join(BASE, "public", "register.html")
    );
  } catch (err) {
    next(err);
  }
});

// app.get("/register", (req, res) => {

//   if (req.session?.userId) return res.redirect("/");
//   res.sendFile(path.join(BASE, "public", "register.html"));
// });

app.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(BASE, "public", "index.html"));
});

app.get("/change-password", requireAuth, (req, res) => {
  res.sendFile(path.join(BASE, "public", "change-password.html"));
});

app.use("/files", requireAuth, express.static(DOWNLOAD_DIR));

// app.use("/api", requireAuth);

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
      } catch (e) { }
    }
  });

  return Array.from(itemsMap.values());
}



app.post("/api/add", requireAuth, async (req, res) => {
  try {
    const link = validateLink(req.body?.url);
    const gid = await rpc("aria2.addUri", [[link], { dir: DOWNLOAD_DIR, continue: "true" }]);
    res.json({ gid, message: "Download added." });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/torrent", requireAuth, express.raw({ type: "application/x-bittorrent", limit: "10mb" }), async (req, res) => {
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

app.get("/api/downloads", requireAuth, async (req, res) => {
  try {
    const list = await getMergedDownloads();
    const socialDownloads = [...socialJobs.values()]
      .filter(job =>
        job.userId === req.session.userId &&
        ["downloading", "converting"].includes(job.status)
      )
      .map(job => ({
        gid: "social_" + job.id,
        name: job.name || "Social-media video",
        status: job.status === "downloading"
          ? "active"
          : "converting",
        total: job.totalBytes || 0,
        done: job.downloadedBytes || 0,
        speed: job.speed || 0,
        progress: job.status === "converting"
          ? 100
          : parseFloat(job.progress) || 0,
        error: job.error || "",
        seeders: 0,
        onDisk: false,
        social: true,
        eta: job.eta || ""
      }));

    list.push(...socialDownloads);
    res.json({ downloads: list, folder: DOWNLOAD_DIR });
  } catch (e) {
    res.status(503).json({ error: "Storage sync error: " + e.message });
  }
});

// app.get("/api/downloads", requireAuth, async (req, res) => {
//   try {
//     const list = await getMergedDownloads();
//     res.json({ downloads: list, folder: DOWNLOAD_DIR });
//   } catch (e) {
//     res.status(503).json({ error: "Storage sync error: " + e.message });
//   }
// });


app.post("/api/action", requireAuth, async (req, res) => {
  const { gid, action, name } = req.body || {};

  if (action === "remove") {
    try {
      if (!isAdminUser(req)) {
        return res.status(403).json({
          error: "Only administrators can delete downloads."
        });
      }
    } catch (err) {
      console.error("Role verification failed:", err.message);

      return res.status(500).json({
        error: "Unable to verify account permissions."
      });
    }
  }

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
          try { await rpc("aria2.removeDownloadResult", [gid]); } catch (err) { }
        }
      }
    }

    // 2. Wipes physical file allocations if action target is explicitly "remove"
    if (action === "remove" && name) {


      const rootPath = path.resolve(DOWNLOAD_DIR);
      const targetPath = path.resolve(rootPath, name || "");
      const relativePath = path.relative(rootPath, targetPath);

      const isInsideDownloadDir =
        relativePath !== "" &&
        relativePath !== ".." &&
        !relativePath.startsWith(".." + path.sep) &&
        !path.isAbsolute(relativePath);

      if (action === "remove" && name && isInsideDownloadDir) {
        const metaControlPath = targetPath + ".aria2";

        if (fs.existsSync(targetPath)) {
          fs.rmSync(targetPath, { recursive: true, force: true });
        }

        if (fs.existsSync(metaControlPath)) {
          fs.rmSync(metaControlPath, { force: true });
        }
      }

      // if (targetPath.startsWith(DOWNLOAD_DIR)) {
      //   if (fs.existsSync(targetPath)) {
      //     fs.rmSync(targetPath, { recursive: true, force: true });
      //   }
      //   if (fs.existsSync(metaControlPath)) {
      //     fs.rmSync(metaControlPath, { force: true });
      //   }
      // }
    }

    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});







// Registration
app.post("/api/register", requireAdmin, async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (typeof username !== "string" ||
      typeof password !== "string") {
      return res.status(400).json({
        error: "Username and password are required."
      });
    }

    const cleanUsername = username.trim();

    if (!/^[a-zA-Z0-9_]{3,24}$/.test(cleanUsername)) {
      return res.status(400).json({
        error: "Username must be 3–24 characters using letters, numbers or underscores."
      });
    }

    if (password.length < 8 || Buffer.byteLength(password, "utf8") > 72) {
      return res.status(400).json({
        error: "Password must be at least 8 characters and at most 72 UTF-8 bytes."
      });
    }

    const users = readUsers();

    if (users.some(u =>
      u.username.toLowerCase() === cleanUsername.toLowerCase()
    )) {
      return res.status(409).json({
        error: "That username is already registered."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    const user = {
      id: crypto.randomUUID(),
      username: cleanUsername,
      passwordHash,
      role: "user",
      createdAt: new Date().toISOString()
    };

    users.push(user);
    writeUsers(users);

    res.status(201).json({
      success: true,
      message: "Registration successful. Please log in."
    });
  } catch (err) {
    next(err);
  }
});


// Login
app.post("/api/login", async (req, res, next) => {
  try {
    const { username, password } = req.body || {};

    if (typeof username !== "string" ||
      typeof password !== "string") {
      return res.status(400).json({
        error: "Username and password are required."
      });
    }

    const users = readUsers();

    const user = users.find(u =>
      u.username.toLowerCase() === username.trim().toLowerCase()
    );

    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
      return res.status(401).json({
        error: "Invalid username or password."
      });
    }

    req.session.regenerate(err => {
      if (err) return next(err);

      req.session.userId = user.id;
      req.session.username = user.username;
      req.session.role = user.role || "user";

      req.session.save(err => {
        if (err) return next(err);

        res.json({
          success: true,
          username: user.username
        });
      });
    });
  } catch (err) {
    next(err);
  }
});



// Current logged-in user
app.get("/api/me", (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({
      authenticated: false
    });
  }

  res.json({
    authenticated: true,
    username: req.session.username,
    role: req.session.role || "user"
  });
});


// Logout
app.post("/api/logout", requireAuth, (req, res, next) => {
  req.session.destroy(err => {
    if (err) return next(err);

    res.clearCookie("cloudlocal.sid", {
      httpOnly: true,
      sameSite: "strict",
      secure: false
    });

    res.json({ success: true });
  });
});




// app.get("/", requireAuth, (req, res) => {
//   res.sendFile(path.join(BASE, "public", "index.html"));
// });

// Protect file downloads.
// app.use("/files", requireAuth, express.static(DOWNLOAD_DIR));

// Protect every remaining /api route.


app.post("/api/change-password", requireAuth, async (req, res, next) => {
  try {
    const { oldPassword, newPassword } = req.body || {};

    if (
      typeof oldPassword !== "string" ||
      typeof newPassword !== "string"
    ) {
      return res.status(400).json({
        error: "Current password and new password are required."
      });
    }

    if (
      newPassword.length < 8 ||
      Buffer.byteLength(newPassword, "utf8") > 72
    ) {
      return res.status(400).json({
        error: "New password must be at least 8 characters and at most 72 UTF-8 bytes."
      });
    }

    if (oldPassword === newPassword) {
      return res.status(400).json({
        error: "Your new password must be different from your current password."
      });
    }

    const users = readUsers();

    const userIndex = users.findIndex(
      u => u.id === req.session.userId
    );

    if (userIndex === -1) {
      return res.status(401).json({
        error: "Account not found. Please log in again."
      });
    }

    const user = users[userIndex];

    // Verify the current password before allowing a change
    const validPassword = await bcrypt.compare(
      oldPassword,
      user.passwordHash
    );

    if (!validPassword) {
      return res.status(400).json({
        error: "Your current password is incorrect."
      });
    }

    // Hash and save the new password
    const newPasswordHash = await bcrypt.hash(newPassword, 12);

    // Re-read before writing to avoid overwriting unrelated user updates
    const latestUsers = readUsers();
    const latestIndex = latestUsers.findIndex(
      u => u.id === req.session.userId
    );

    if (
      latestIndex === -1 ||
      latestUsers[latestIndex].passwordHash !== user.passwordHash
    ) {
      return res.status(409).json({
        error: "Your account changed during this request. Please try again."
      });
    }

    latestUsers[latestIndex].passwordHash = newPasswordHash;
    writeUsers(latestUsers);

    return res.json({
      success: true,
      message: "Password changed successfully."
    });
  } catch (err) {
    next(err);
  }
});








function validateSocialUrl(input) {
  if (
    typeof input !== "string" ||
    !input.trim() ||
    input.length > 8192
  ) {
    throw new Error("Please enter a valid video URL.");
  }

  let url;

  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter a valid video URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS URLs are supported.");
  }

  const host = url.hostname.toLowerCase();

  // Explicit allowlist: add more domains as needed.
  const allowedHosts = [
    "youtube.com",
    "youtu.be",
    "youtube-nocookie.com",
    "facebook.com",
    "fb.watch",
    "instagram.com",
    "tiktok.com",
    "vimeo.com",
    "twitter.com",
    "x.com",
    "reddit.com"
  ];

  const allowed = allowedHosts.some(
    domain => host === domain || host.endsWith("." + domain)
  );

  if (!allowed) {
    throw new Error(
      "This domain is not enabled for social-media downloads."
    );
  }

  return url.toString();
}




app.post("/api/social-download", requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(YTDLP)) {
      return res.status(503).json({
        error: "yt-dlp.exe was not found beside server.js."
      });
    }

    if (!fs.existsSync(FFMPEG)) {
      return res.status(503).json({
        error: "ffmpeg.exe was not found beside server.js."
      });
    }

    const url = validateSocialUrl(req.body?.url);

    // Limit simultaneous social downloads.
    const running = [...socialJobs.values()].filter(
      job => ["downloading", "converting"].includes(job.status)
    ).length;

    if (running >= 3) {
      return res.status(429).json({
        error: "Too many active social-media downloads."
      });
    }

    const id = crypto.randomUUID();

    // Each job gets its own temporary directory to prevent
    // simultaneous downloads from mixing up their files.
    const jobDir = path.join(DOWNLOAD_DIR, ".social-" + id);

    fs.mkdirSync(jobDir, { recursive: true });

    const job = {
      id,
      userId: req.session.userId,
      status: "downloading",
      name: "Preparing video...",
      progress: "",
      downloadedBytes: 0,
      totalBytes: 0,
      speed: 0,
      eta: "",
      error: "",
      createdAt: new Date().toISOString()
    };


    // const job = {
    //   id,
    //   userId: req.session.userId,
    //   status: "downloading",
    //   progress: "",
    //   error: "",
    //   createdAt: new Date().toISOString()
    // };

    socialJobs.set(id, job);

    const child = spawn(YTDLP, [
      "--no-playlist",
      "--newline",
      "--progress",
      "--progress-template",
      "download:PROGRESS|%(progress._percent_str)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s",

      // Prefer H.264/AAC, but allow other source formats.
      "-f",
      "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv*+ba/b",

      // Save the source in this job's private directory.
      "-P",
      jobDir,

      "-o",
      "%(title).180B [%(id)s].%(ext)s",

      "--ffmpeg-location",
      BASE,

      "--",
      url
    ], {
      cwd: BASE,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false
    });

    job.process = child;

    let stderr = "";
    let childError = null;

    let stdoutBuffer = "";

    child.stdout.setEncoding("utf8");

    child.stdout.on("data", chunk => {
      stdoutBuffer += chunk;

      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("PROGRESS|")) continue;

        const parts = line.split("|");

        job.progress = (parts[1] || "").trim();
        job.downloadedBytes = Number(parts[2]) || 0;

        const totalBytes = Number(parts[3]) || 0;
        const estimatedBytes = Number(parts[4]) || 0;

        job.totalBytes = totalBytes || estimatedBytes;
        job.speed = Number(parts[5]) || 0;
        job.eta = (parts[6] || "").trim();
      }
    });
    // child.stdout.on("data", chunk => {
    //   for (const line of chunk.split(/\r?\n/)) {
    //     if (line.startsWith("PROGRESS:")) {
    //       job.progress = line.slice("PROGRESS:".length).trim();
    //     }
    //   }
    // });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => {
      stderr = (stderr + chunk).slice(-4000);
    });

    child.on("error", err => {
      childError = err;
    });

    child.on("close", async code => {
      delete job.process;

      if (job.status === "cancelled") {
        fs.rmSync(jobDir, { recursive: true, force: true });
        return;
      }

      if (childError || code !== 0) {
        job.status = "error";
        job.error = childError?.message ||
          stderr.trim().split(/\r?\n/).slice(-3).join(" ") ||
          `yt-dlp exited with code ${code}`;

        fs.rmSync(jobDir, { recursive: true, force: true });
        return;
      }

      // Download succeeded. Now explicitly encode the video.
      // job.status = "converting";
      // job.progress = "Converting to MP4...";

      job.status = "converting";
      job.progress = "100%";
      job.speed = 0;
      job.eta = "";

      try {
        const sourceFiles = fs.readdirSync(jobDir, {
          withFileTypes: true
        }).filter(entry =>
          entry.isFile() &&
          !entry.name.endsWith(".part") &&
          !entry.name.endsWith(".ytdl") &&
          !entry.name.endsWith(".json") &&
          !entry.name.endsWith(".description") &&
          !entry.name.endsWith(".jpg") &&
          !entry.name.endsWith(".webp") &&
          !entry.name.endsWith(".png")
        );

        if (sourceFiles.length === 0) {
          throw new Error("Downloaded video file was not found.");
        }

        // Prefer the largest media file in this job's directory.
        const source = sourceFiles
          .map(entry => ({
            name: entry.name,
            fullPath: path.join(jobDir, entry.name),
            size: fs.statSync(path.join(jobDir, entry.name)).size
          }))
          .sort((a, b) => b.size - a.size)[0];

        const baseName = path.parse(source.name).name;
        const safeName = baseName
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
          .replace(/[. ]+$/, "")
          .slice(0, 180) || `video-${id}`;

        const outputPath = path.join(
          DOWNLOAD_DIR,
          safeName + ".mp4"
        );

        // Use a unique temporary output file until conversion succeeds.
        const tempOutput = path.join(
          jobDir,
          "converted-" + id + ".mp4"
        );

        await new Promise((resolve, reject) => {
          const ffmpeg = spawn(FFMPEG, [
            "-y",
            "-i", source.fullPath,

            // Map video and optional audio; ignore subtitles/data.
            "-map", "0:v:0",
            "-map", "0:a:0?",

            // Widely compatible codecs.
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-crf", "22",
            "-pix_fmt", "yuv420p",
            "-c:a", "aac",
            "-b:a", "192k",

            // Improve playback when streaming the MP4.
            "-movflags", "+faststart",

            tempOutput
          ], {
            cwd: BASE,
            windowsHide: true,
            stdio: ["ignore", "ignore", "pipe"],
            shell: false
          });

          let ffmpegStderr = "";
          let ffmpegError = null;

          ffmpeg.stderr.setEncoding("utf8");
          ffmpeg.stderr.on("data", chunk => {
            ffmpegStderr = (ffmpegStderr + chunk).slice(-4000);
          });

          ffmpeg.on("error", err => {
            ffmpegError = err;
          });

          ffmpeg.on("close", exitCode => {
            if (ffmpegError) {
              reject(ffmpegError);
            } else if (exitCode === 0) {
              resolve();
            } else {
              reject(new Error(
                ffmpegStderr.trim().split(/\r?\n/).slice(-3).join(" ") ||
                `FFmpeg exited with code ${exitCode}`
              ));
            }
          });
        });

        // Publish the final file only after conversion succeeds.
        // Avoid overwriting an existing file accidentally.
        let finalPath = outputPath;

        if (fs.existsSync(finalPath)) {
          finalPath = path.join(
            DOWNLOAD_DIR,
            safeName + " [" + id.slice(0, 8) + "].mp4"
          );
        }

        fs.renameSync(tempOutput, finalPath);

        job.status = "complete";
        job.progress = "100%";
        job.speed = 0;
        job.eta = "";
        job.error = "";

        job.name = path.basename(finalPath);

        // job.status = "complete";
        // job.progress = "100%";
        // job.error = "";
      } catch (err) {
        job.status = "error";
        job.error = err.message;
      } finally {
        fs.rmSync(jobDir, { recursive: true, force: true });
      }
    });

    return res.status(202).json({
      success: true,
      id,
      message: "Social-media download started."
    });
  } catch (err) {
    return res.status(400).json({
      error: err.message
    });
  }
});







// app.post("/api/social-download", requireAuth, (req, res) => {
//   try {
//     if (!fs.existsSync(YTDLP)) {
//       return res.status(503).json({
//         error: "yt-dlp.exe was not found beside server.js."
//       });
//     }

//     const url = validateSocialUrl(req.body?.url);

//     // Limit simultaneous social downloads.
//     const running = [...socialJobs.values()].filter(
//       job => job.status === "downloading"
//     ).length;

//     if (running >= 3) {
//       return res.status(429).json({
//         error: "Too many active social-media downloads."
//       });
//     }

//     const id = crypto.randomUUID();

//     const job = {
//       id,
//       userId: req.session.userId,
//       status: "downloading",
//       progress: "",
//       error: "",
//       createdAt: new Date().toISOString()
//     };

//     socialJobs.set(id, job);

//     const child = spawn(YTDLP, [
//   "--no-playlist",
//   "--newline",
//   "--progress",
//   "--progress-template",
//   "download:PROGRESS:%(progress._percent_str)s",

//   // Select video and audio, with a fallback to a combined format.
//   "-f",
//   "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/bv*+ba/b",
//   // "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]",
//   // "bv*[vcodec^=avc1]+ba[acodec^=mp4a]/b[vcodec^=avc1][acodec^=mp4a]/b",

//   // Merge separate streams into an MP4 container.
//   "--merge-output-format",
//   "mp4",

//   "--recode-video",
//   "mp4",

//   "--postprocessor-args",
//   "VideoConvertor+ffmpeg:-c:v libx264 -c:a aac",

//   // Explicitly tell yt-dlp where FFmpeg is located.
//   "--ffmpeg-location",
//   BASE,

//   // Output directory and filename.
//   "-P",
//   DOWNLOAD_DIR,
//   "-o",
//   "%(title).180B [%(id)s].%(ext)s",

//   "--",
//   url
// ], {
//   cwd: BASE,
//   windowsHide: true,
//   stdio: ["ignore", "pipe", "pipe"],
//   shell: false
// });

//     job.process = child;

//     let stderr = "";

//     child.stdout.setEncoding("utf8");
//     child.stdout.on("data", chunk => {
//       for (const line of chunk.split(/\r?\n/)) {
//         if (line.startsWith("PROGRESS:")) {
//           job.progress = line.slice("PROGRESS:".length).trim();
//         }
//       }
//     });

//     child.stderr.setEncoding("utf8");
//     child.stderr.on("data", chunk => {
//       stderr = (stderr + chunk).slice(-4000);
//     });

//     child.on("error", err => {
//       job.status = "error";
//       job.error = err.message;
//       delete job.process;
//     });

//     child.on("close", code => {
//       if (job.status === "cancelled") return;

//       job.status = code === 0 ? "complete" : "error";
//       job.error = code === 0
//         ? ""
//         : (stderr.trim().split(/\r?\n/).slice(-3).join(" ") ||
//            `yt-dlp exited with code ${code}`);

//       if (code === 0) job.progress = "100%";

//       delete job.process;
//     });

//     return res.status(202).json({
//       success: true,
//       id,
//       message: "Social-media download started."
//     });
//   } catch (err) {
//     return res.status(400).json({ error: err.message });
//   }
// });



// Read a job's progress. Only the user who started it can see it.

app.get("/api/social-download/:id", requireAuth, (req, res) => {
  const job = socialJobs.get(req.params.id);

  if (!job || job.userId !== req.session.userId) {
    return res.status(404).json({
      error: "Download job not found."
    });
  }

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress || "",
    error: job.error || ""
  });
});

// app.get("/api/social-download/:id", requireAuth, (req, res) => {
//   const job = socialJobs.get(req.params.id);

//   if (!job || job.userId !== req.session.userId) {
//     return res.status(404).json({ error: "Download job not found." });
//   }

//   res.json({
//     id: job.id,
//     status: job.status,
//     progress: job.progress,
//     error: job.error
//   });
// });








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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`SeedrLocal: http://0.0.0.0:${PORT}`);
    console.log(`Downloads: ${DOWNLOAD_DIR}`);
  });
}

main().catch(err => {
  console.error("Startup failed:", err.message);
  if (aria2 && aria2.exitCode === null) aria2.kill();
  process.exitCode = 1;
});
