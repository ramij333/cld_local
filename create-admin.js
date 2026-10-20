
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const readline = require("readline");

const USERS_FILE = path.join(__dirname, "users.json");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function ask(question) {
  return new Promise(resolve => rl.question(question, resolve));
}

async function main() {
  if (!fs.existsSync(USERS_FILE)) {
    throw new Error("users.json does not exist.");
  }

  const data = JSON.parse(
    fs.readFileSync(USERS_FILE, "utf8")
  );

  if (!data || !Array.isArray(data.users)) {
    throw new Error("Invalid users.json format.");
  }

  if (data.users.some(user => user.role === "admin")) {
    throw new Error(
      "An admin already exists. Use the admin management feature instead."
    );
  }

  if (data.users.length > 0) {
    throw new Error(
      "users.json is not empty. Stop and review existing accounts first."
    );
  }

  const username = (await ask("Admin username: ")).trim();

  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) {
    throw new Error(
      "Username must be 3-24 letters, numbers, or underscores."
    );
  }

  const password = await ask("Admin password (input is visible): ");

  if (
    password.length < 8 ||
    Buffer.byteLength(password, "utf8") > 72
  ) {
    throw new Error(
      "Password must be at least 8 characters and at most 72 UTF-8 bytes."
    );
  }

  const confirm = await ask("Confirm admin password: ");

  if (password !== confirm) {
    throw new Error("Passwords do not match.");
  }

  const passwordHash = await bcrypt.hash(password, 12);

  data.users.push({
    id: crypto.randomUUID(),
    username,
    passwordHash,
    role: "admin",
    createdAt: new Date().toISOString()
  });

  // Exclusive file creation avoids silently overwriting the file.
  const tempFile = USERS_FILE + "." + crypto.randomUUID() + ".tmp";

  try {
    fs.writeFileSync(
      tempFile,
      JSON.stringify(data, null, 2),
      { encoding: "utf8", flag: "wx", mode: 0o600 }
    );

    fs.renameSync(tempFile, USERS_FILE);
  } finally {
    if (fs.existsSync(tempFile)) {
      fs.unlinkSync(tempFile);
    }
  }

  console.log(`Admin account "${username}" created successfully.`);
}

main()
  .catch(error => {
    console.error("Setup failed:", error.message);
    process.exitCode = 1;
  })
  .finally(() => rl.close());
