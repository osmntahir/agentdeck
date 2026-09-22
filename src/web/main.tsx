import React from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import { App } from './App'
import './styles.css'

// xterm hücre ölçüsünü açılışta bir kez alır; terminal yazı tipi ilk çizimden önce hazır olmalı.
// Yükleme başarısız olsa da uygulama yedek yazı tipiyle açılır.
Promise.allSettled([
  document.fonts.load('13px "JetBrains Mono Variable"'),
  document.fonts.load('600 13px "JetBrains Mono Variable"'),
  document.fonts.load('13px "Inter Variable"'),
]).finally(() => {
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )
})
