import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

// Spanish decimal comma for every number the HUD and the 3D labels show.
const DECIMAL = /(\d)\.(\d)/g;
const localize = (node: Node) => {
  if (node.nodeType === Node.TEXT_NODE) {
    const v = node.nodeValue;
    if (v && DECIMAL.test(v)) node.nodeValue = v.replace(DECIMAL, '$1,$2');
    DECIMAL.lastIndex = 0;
    return;
  }
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) localize(t);
};
new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === 'characterData') localize(r.target);
    else r.addedNodes.forEach(localize);
  }
}).observe(document.body, { childList: true, characterData: true, subtree: true });
