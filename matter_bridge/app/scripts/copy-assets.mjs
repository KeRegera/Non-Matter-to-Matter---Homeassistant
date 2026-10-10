import { copyFileSync, mkdirSync } from "node:fs";

mkdirSync("dist/web", { recursive: true });
copyFileSync("src/web/ui.html", "dist/web/ui.html");
