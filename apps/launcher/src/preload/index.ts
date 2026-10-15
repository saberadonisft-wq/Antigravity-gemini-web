import { contextBridge, ipcRenderer } from "electron";
import { createPreloadClient } from "./client.js";
contextBridge.exposeInMainWorld("launcherClient", createPreloadClient(ipcRenderer));
ipcRenderer.send("launcher:preload-ready", { sandboxed: process.sandboxed, contextIsolated: process.contextIsolated });
