import { app, BrowserWindow, screen } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Only used by --fullscreen-check. A separate PID is necessary to test the actual Win32 detector.
app.setPath('userData', process.env.STOCK_BAR_FIXTURE_PROFILE!);
void app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 700, height: 450, show: false, alwaysOnTop: true, title: '全屏验收测试窗口',
    backgroundColor: '#17243a', webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  window.setMenu(null);
  await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<body style="background:#17243a;color:#dce7f7;font:24px sans-serif;padding:60px">行情悬浮条：全屏自动隐藏验收<br><small>本窗口将在检查结束后自动关闭。</small></body>'));
  window.show();
  const directory = process.env.STOCK_BAR_FIXTURE_PROFILE!;
  let sequence = 0;
  const reply = () => writeFile(join(directory, 'reply.json'), JSON.stringify({ sequence, fullscreen: window.isFullScreen(), maximized: window.isMaximized() }));
  await reply();
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return; busy = true;
    try {
    const request = JSON.parse(await readFile(join(directory, 'command.json'), 'utf8'));
    if (request.sequence <= sequence) return;
    sequence = request.sequence;
    const command: string = request.command;
    if (command === 'quit') { app.quit(); return; }
    await window.webContents.executeJavaScript('document.fullscreenElement ? document.exitFullscreen() : undefined');
    window.setFullScreen(false); window.unmaximize();
    await new Promise(done => setTimeout(done, 250));
    if (command.startsWith('display:')) {
      const display = screen.getAllDisplays()[Number(command.split(':')[1])];
      if (display) window.setBounds({ x: display.workArea.x + 100, y: display.workArea.y + 100, width: 700, height: 450 });
    }
    window.show(); window.focus();
    if (command === 'maximize') window.maximize();
    if (command === 'fullscreen') window.setFullScreen(true);
    if (command === 'video') {
      await window.webContents.executeJavaScript(`(async () => {
        let video = document.querySelector('video');
        if (!video) {
          const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
          const context = canvas.getContext('2d'); context.fillStyle = '#254d80'; context.fillRect(0, 0, 640, 360);
          context.fillStyle = 'white'; context.font = '28px sans-serif'; context.fillText('Fullscreen video acceptance', 60, 180);
          video = document.createElement('video'); video.muted = true; video.srcObject = canvas.captureStream(1);
          document.body.append(video); await video.play();
        }
        await video.requestFullscreen();
      })()`, true);
    }
    await new Promise(done => setTimeout(done, 350)); await reply();
    } catch {} finally { busy = false; }
  }, 100);
  app.on('before-quit', () => clearInterval(timer));
  setTimeout(() => app.quit(), 90000); // No orphan test window if the driver fails.
});
