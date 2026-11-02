if (process.argv.includes('--panel-click-fixture')) require('./panel-click-fixture');
else if (process.argv.includes('--fullscreen-fixture')) require('./fullscreen-fixture');
else if (process.argv.some(arg => ['--probe', '--probe-ui', '--probe-smoke', '--probe-ui-check'].includes(arg))) require('./probe-main');
else require('./desktop');
