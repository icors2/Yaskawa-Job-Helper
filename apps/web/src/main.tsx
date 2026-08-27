import React from "react"
import ReactDOM from "react-dom/client"
import { BrowserRouter } from "react-router-dom"
import App from "./App"
import { PlatformProvider } from "./context/PlatformContext"
import "./index.css"

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <BrowserRouter>
      <PlatformProvider>
        <App />
      </PlatformProvider>
    </BrowserRouter>
  </React.StrictMode>
)
