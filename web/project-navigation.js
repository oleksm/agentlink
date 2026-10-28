// One history entry per registry navigation, with scroll saved per entry.
function registryNavigation(draw, paneIds = []) {
  const route = () => decodeURIComponent(location.hash.slice(1));
  const snapshot = () => ({key: route(), x: window.scrollX, y: window.scrollY,
    panes: Object.fromEntries(paneIds.map(id => {const p=document.getElementById(id);return [id,[p?.scrollLeft||0,p?.scrollTop||0]];}))});
  let restoring = false, generation = 0, renderedURL = '';
  history.scrollRestoration = 'manual';
  const save = () => {if (!restoring) history.replaceState({...history.state, registryView:snapshot()}, '', location.href);};
  const show = view => {
    restoring=true; const ticket=++generation; renderedURL=location.href;
    draw(route());
    if (typeof updateProjectTimes === "function") updateProjectTimes();
    const apply = () => {
      if(ticket!==generation)return;
      for(const [id,pos] of Object.entries(view?.panes||{})) document.getElementById(id)?.scrollTo(pos[0],pos[1]);
      window.scrollTo(view?.x||0,view?.y||0);
    };
    apply();
    requestAnimationFrame(() => {apply();if(ticket===generation){restoring=false;save();}});
  };
  const restore = () => show(history.state?.registryView || {x:0,y:0,panes:{}});
  addEventListener('popstate',restore);
  addEventListener('hashchange',() => {if(location.href!==renderedURL) restore();});
  addEventListener('scroll',save,{passive:true});
  for(const id of paneIds) document.getElementById(id)?.addEventListener('scroll',save,{passive:true});
  const go = (key,anchor) => {
    save();
    const next={key,x:0,y:0,panes:snapshot().panes};
    if(next.panes.detail)next.panes.detail=[0,0];
    if(key!==route() || anchor) history.pushState({...history.state,registryView:next},'', '#'+encodeURIComponent(key));
    else { draw(key);return; }
    show(next);
    if(anchor)requestAnimationFrame(() => {document.getElementById(anchor)?.scrollIntoView();save();});
  };
  if(!history.state?.registryView)save();
  restore();
  return {go};
}
