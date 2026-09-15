// Host-authored, read-only page inspection. Never interpolate a model script or
// expose Electron/IPC to a document. Everything returned remains untrusted data.
export const browserInspection = `(() => {
  const elements = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
    .map(e => {
      const r = e.getBoundingClientRect();
      const style = getComputedStyle(e);
      if (!r.width || !r.height || style.visibility !== 'visible' || style.display === 'none' || Number(style.opacity) === 0) return null;
      const left = Math.max(0,r.left), top = Math.max(0,r.top), right = Math.min(innerWidth,r.right), bottom = Math.min(innerHeight,r.bottom);
      if (right <= left || bottom <= top) return null;
      const sensitive = e.type === 'password' || e.type === 'hidden' || /password|one-time-code|cc-/.test(e.autocomplete || '');
      return { tag: e.tagName.toLowerCase(), role: e.getAttribute('role'),
        name: (e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.innerText || e.getAttribute('name') || '').slice(0,180),
        type: e.getAttribute('type'), disabled: !!e.disabled, focused: document.activeElement === e,
        ...('value' in e ? (sensitive ? {value_redacted:true} : {value:String(e.value).slice(0,4000)}) : {}),
        click: {x: Math.floor((left+right)/2), y: Math.floor((top+bottom)/2)},
        bounds: {left:r.left, top:r.top, width:r.width, height:r.height} };
    }).filter(Boolean).slice(0,100);
  return { url: location.href, title: document.title, text: (document.body?.innerText || '').slice(0,20000),
    viewport: {width: innerWidth, height: innerHeight},
    coordinates:'Use element.click.x and element.click.y directly for input.x/y. They are viewport click points, not box corners. Do not add half the width or height.', elements };
})()`;
