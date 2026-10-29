// Electron target for the cua-vs-Orca background bench. Writes page state to $BENCH_STATE_DIR/state.json; obeys $BENCH_STATE_DIR/cmd.
const { app, BrowserWindow, ipcMain } = require('electron')
const fs = require('fs')
const path = require('path')
const dir = process.env.BENCH_STATE_DIR
const statePath = path.join(dir, 'state.json')
const cmdPath = path.join(dir, 'cmd')
app.whenReady().then(() => {
  const w = new BrowserWindow({
    x: 60, y: 60, width: 760, height: 560, title: 'BenchElectron',
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false }
  })
  let last = ''
  ipcMain.on('st', (_e, s) => {
    const data = JSON.stringify({ ...s, activeForm: w.isFocused(), pid: process.pid })
    if (data !== last) {
      last = data
      try { fs.writeFileSync(statePath + '.tmp', data); fs.renameSync(statePath + '.tmp', statePath) } catch {}
    }
  })
  w.loadURL('data:text/html,' + encodeURIComponent(`<html><head><title>BenchElectron</title></head><body style="font:14px sans-serif;height:4000px">
  <input id=i aria-label="field" autofocus> <button id=b onclick="c++">Increment</button>
  <select id=sel aria-label="Color"><option>Red</option><option>Green</option><option>Blue</option></select>
  <script>const {ipcRenderer}=require('electron');var c=0,ret=0;const I=document.getElementById('i'),S=document.getElementById('sel');
  I.addEventListener('keydown',e=>{if(e.key==='Enter')ret++});
  function s(){ipcRenderer.send('st',{count:c,text:I.value,returns:ret,scrollY:window.scrollY,top:window.scrollY,combo:S.value,selStart:I.selectionStart,selLen:I.selectionEnd-I.selectionStart,fieldFocused:document.activeElement===I,hasFocus:document.hasFocus()})}
  ipcRenderer.on('cmd',(_e,k)=>{if(k==='reset'){c=0;ret=0;I.value='';window.scrollTo(0,0);S.selectedIndex=0;I.focus()}if(k==='setHello'){I.focus();I.value='hello';I.setSelectionRange(5,5);ret=0}s()});
  setInterval(s,30)</script></body></html>`))
  setInterval(() => {
    try {
      const k = fs.readFileSync(cmdPath, 'utf8').trim()
      if (k) { fs.writeFileSync(cmdPath, ''); if (k === 'quit') app.quit(); else w.webContents.send('cmd', k) }
    } catch {}
  }, 30)
})
