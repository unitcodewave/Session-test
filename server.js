const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs-extra");
const path = require("path");
const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(bodyParser.json());
app.use(express.static(__dirname));

const SESSIONS_DIR = path.join(__dirname, "sessions");
fs.ensureDirSync(SESSIONS_DIR);

app.post("/generate-session", async (req, res) => {
    const number = req.body.number;
    if (!number) return res.json({ error: "Phone number required" });

    const sessionFolder = path.join(SESSIONS_DIR, number);

    // create auth state for the number
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        syncFullHistory: true
    });

    sock.ev.on("creds.update", saveCreds);

    // listen for connection open
    sock.ev.once("connection.update", async (update) => {
        const { connection } = update;
        if (connection === "open") {
            // send creds.json to user
            const credsPath = path.join(sessionFolder, "creds.json");
            if (fs.existsSync(credsPath)) {
                await sock.sendMessage(number + "@s.whatsapp.net", {
                    document: { url: credsPath },
                    fileName: "creds.json",
                    mimetype: "application/json"
                });
            }
            res.json({ message: "Session created and sent!" });
        }
    });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));