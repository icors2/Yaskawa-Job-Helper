import React from "react"
import ReactDOM from "react-dom/client"
import { setFileSystemPort } from "@yaskawa/core/ports/filesystem"
import { setStoragePort } from "@yaskawa/core/ports/storage"
import App from "./App"
import { createTauriFileSystemPort } from "./lib/fs/tauriFileSystem"
import { createTauriStoragePort } from "./lib/fs/tauriStorage"
import "./index.css"

setStoragePort(createTauriStoragePort())
setFileSystemPort(createTauriFileSystemPort())

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
