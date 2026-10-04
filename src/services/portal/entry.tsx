import { createRoot } from 'react-dom/client';
import Portal from './Portal';

const container = document.getElementById('service-portal');
if (container) {
  const root = createRoot(container);
  root.render(<Portal />);
  if (import.meta.hot) import.meta.hot.dispose(()=>root.unmount());
}
