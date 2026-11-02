import { BrowserWindow, desktopCapturer, screen } from 'electron';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WatchlistPanel } from './watchlist-panel';

/** Explicit diagnostic only: retain crops of the fixture panel, never the surrounding desktop. */
export async function checkPanelFlash(bar: BrowserWindow, panel: WatchlistPanel, directory: string) {
  const display = screen.getDisplayMatching(bar.getBounds());
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find(item => item.display_id === String(display.id));
  if (!source) throw Error('No screen capture source for fixture display');
  const ses = bar.webContents.session;
  ses.setDisplayMediaRequestHandler((request, callback) => callback(request.frame === bar.webContents.mainFrame ? { video: source } : {}));
  const pause = (ms: number) => new Promise(done => setTimeout(done, ms));
  const backing = new BrowserWindow({ ...display.workArea, show: false, frame: false, focusable: false,
    skipTaskbar: true, backgroundColor: '#ff00ff', webPreferences: { sandbox: true } });
  await backing.loadURL('data:text/html,' + encodeURIComponent('<style>body{margin:0;background:#ff00ff}i{position:fixed;top:2px;left:2px;width:12px;height:12px;background:#0f0;animation:pulse .2s infinite alternate}@keyframes pulse{to{opacity:.2}}</style><i></i>'));
  backing.showInactive(); bar.showInactive();
  const window = panel.open()!;
  while (window.webContents.isLoading()) await pause(20);
  await pause(300);
  const bounds = window.getBounds();
  const region = { x: bounds.x - display.bounds.x + 10, y: bounds.y - display.bounds.y + 10,
    width: bounds.width - 20, height: bounds.height - 20 };
  const events: { event: string; at: number }[] = [];
  const shown = () => events.push({ event: 'show', at: Date.now() });
  const hidden = () => events.push({ event: 'hide', at: Date.now() });
  const resized = () => events.push({ event: 'resize', at: Date.now() });
  window.on('show', shown); window.on('hide', hidden); window.on('resize', resized);
  const script = `async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({video:{frameRate:60},audio:false});
    const video = document.createElement('video'); video.muted=true; video.srcObject=stream; await video.play();
    const canvas=document.createElement('canvas'); canvas.width=192; canvas.height=96;
    const ctx=canvas.getContext('2d',{willReadFrequently:true});
    const region=${JSON.stringify(region)}, display=${JSON.stringify(display.bounds)};
      const state={stream,video,frames:[],cycle:-1,running:true,last:null}; window.__panelFlash=state;
    const capture=()=>{
      if(!state.running)return;
      const sx=video.videoWidth/display.width, sy=video.videoHeight/display.height;
      ctx.drawImage(video,region.x*sx,region.y*sy,region.width*sx,region.height*sy,0,0,192,96);
      const data=ctx.getImageData(0,0,192,96).data;
      let dark=0,bright=0;for(let p=0;p<data.length;p+=4){if(data[p]<80&&data[p+1]<90&&data[p+2]<115)dark++;if(data[p]>225&&data[p+1]>225&&data[p+2]>225)bright++;}
      state.last={dark:dark/(192*96),at:Date.now()};
      if(state.cycle>=0)state.frames.push({cycle:state.cycle,at:Date.now(),dark:dark/(192*96),bright:bright/(192*96),png:canvas.toDataURL('image/png').split(',')[1]});
      video.requestVideoFrameCallback(capture);
    };video.requestVideoFrameCallback(capture);
    return {width:video.videoWidth,height:video.videoHeight};
  }`;
  try {
    const capture = await bar.webContents.executeJavaScript(`(${script})()`, true);
    await pause(300);
    const corners = await bar.webContents.executeJavaScript(`(() => {
      const video=window.__panelFlash.video,display=${JSON.stringify(display.bounds)},bounds=${JSON.stringify(bounds)};
      const sx=video.videoWidth/display.width,sy=video.videoHeight/display.height;
      const canvas=document.createElement('canvas');canvas.width=Math.round(bounds.width*sx);canvas.height=Math.round(bounds.height*sy);
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(video,(bounds.x-display.x)*sx,(bounds.y-display.y)*sy,bounds.width*sx,bounds.height*sy,0,0,canvas.width,canvas.height);
      const depth=Math.ceil(10*Math.max(sx,sy));
      const samples=[[0,0],[canvas.width-depth,0],[0,canvas.height-depth],[canvas.width-depth,canvas.height-depth]].map(([x,y])=>{
        const pixels=ctx.getImageData(x,y,depth,depth).data;let white=0;
        for(let p=0;p<pixels.length;p+=4)if(pixels[p]>220&&pixels[p+1]>220&&pixels[p+2]>220)white++;
        const cut=Math.max(1,Math.floor(2*Math.min(sx,sy)));
        const cutX=x===0?0:canvas.width-cut,cutY=y===0?0:canvas.height-cut;
        const corner=ctx.getImageData(cutX,cutY,cut,cut).data;let backdrop=0;
        for(let p=0;p<corner.length;p+=4)if(corner[p]>180&&corner[p+1]<100&&corner[p+2]>180)backdrop++;
        return {x,y,white,pixels:depth*depth,backdrop:backdrop/(cut*cut)};
      });return {png:canvas.toDataURL('image/png').split(',')[1],samples};
    })()`);
    await writeFile(join(directory, 'desktop-panel-corners.png'), Buffer.from(corners.png, 'base64'));
    await writeFile(join(directory, 'desktop-panel-corners.json'), JSON.stringify(corners.samples, null, 2));
    if (corners.samples.some((sample: {white: number}) => sample.white > 0)) throw Error('White pixels appear around the native panel corners');
    if (corners.samples.some((sample: {backdrop: number}) => sample.backdrop < .8)) throw Error('Panel fills the rounded cutouts instead of revealing the desktop');
    const cycles = [];
    for (let cycle = 0; cycle < 8; cycle++) {
      panel.close(); await pause(550);
      if (!await bar.webContents.executeJavaScript('window.__panelFlash.last?.dark < .1')) throw Error('Collapsed panel is still visible in desktop frames');
      await bar.webContents.executeJavaScript(`window.__panelFlash.cycle=${cycle}`);
      const at = Date.now(); panel.open();
      await pause(650);
      await bar.webContents.executeJavaScript('window.__panelFlash.cycle=-1');
      cycles.push({ cycle, at });
    }
    const frames: {cycle: number; at: number; dark: number; bright: number; png: string}[] = await bar.webContents.executeJavaScript(`(() => {
      const state=window.__panelFlash;state.running=false;state.stream.getTracks().forEach(track=>track.stop());return state.frames;
    })()`);
    const summaries = cycles.map(cycle => {
      const samples = frames.filter(frame => frame.cycle === cycle.cycle);
      const first = samples.findIndex(frame => frame.dark > .8);
      const gaps = first < 0 ? samples.length : samples.slice(first).filter(frame => frame.dark < .7 || frame.bright > .15).length;
      return { ...cycle, samples: samples.length, firstDarkMs: first < 0 ? null : samples[first].at - cycle.at, gaps,
        values: samples.map(({at,dark,bright}) => ({ms:at-cycle.at,dark,bright})) };
    });
    for (const frame of frames.filter(frame => frame.cycle < 2)) {
      await writeFile(join(directory, `flash-${frame.cycle}-${frame.at}.png`), Buffer.from(frame.png, 'base64'));
    }
    await writeFile(join(directory, 'flash-result.json'), JSON.stringify({ capture, events, summaries }, null, 2));
    if (summaries.some(cycle => cycle.samples < 8)) throw Error('Flash capture did not sample at least eight frames per opening');
    if (summaries.some(cycle => cycle.gaps > 0)) throw Error('Panel disappears or paints a bright frame after its first dark frame');
  } finally {
    if (!bar.isDestroyed()) await bar.webContents.executeJavaScript(`window.__panelFlash?.stream.getTracks().forEach(track=>track.stop())`).catch(() => undefined);
    window.removeListener('show', shown); window.removeListener('hide', hidden); window.removeListener('resize', resized);
    ses.setDisplayMediaRequestHandler(null); backing.destroy(); panel.close();
  }
}
