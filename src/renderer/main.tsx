import { createRoot } from 'react-dom/client';
import { StockApp } from './StockApp';
if (new URLSearchParams(location.search).get('view') === 'probe') void import('./Probe');
else createRoot(document.getElementById('root')!).render(<StockApp />);
