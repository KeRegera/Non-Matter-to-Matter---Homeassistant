import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/web", { recursive: true });
copyFileSync("src/web/ui.html", "dist/web/ui.html");
// QR decoder for the browser (camera / photo scanning in the web UI)
copyFileSync("node_modules/jsqr/dist/jsQR.js", "dist/web/jsQR.js");
