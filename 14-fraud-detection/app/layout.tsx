import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: "Tripwire — Fraud & Anomaly Detection",
  description:
    "Fraud/anomaly detection: synthetic transaction dataset, z-score rules + from-scratch isolation forest, explainable flags, precision/recall evaluation.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
