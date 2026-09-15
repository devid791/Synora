import React from 'react';
import {createRoot} from 'react-dom/client';
import {RemoteBrowser} from '../../src/renderer/RemoteBrowser';
import type {DesktopAPI} from '../../src/shared/contracts';
const state={fail:true,tab:'a',calls:[] as string[],reported:[] as string[]};
const api={
 browserFrame:async(id:string)=>{state.calls.push(id);return state.fail?{ok:false,error:{code:'CAPTURE',message:'UnknownVizError'}}:{ok:true,value:{width:1,height:1,dataURL:'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='}};},
 browserInput:async()=>({ok:true,value:null}),
} as unknown as DesktopAPI;
const root=createRoot(document.getElementById('root')!);
const report=(e:unknown)=>state.reported.push(String(e));
function render(){root.render(<RemoteBrowser api={api} id={state.tab} report={report}/>);}
Object.assign(window,{remoteBrowserFixture:{state,render}});render();
