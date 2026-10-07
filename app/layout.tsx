import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Weduu — processamento de SKUs",
  description: "Serviço do desafio técnico: recebimento rápido, enriquecimento e callback.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
