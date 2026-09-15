import test from "node:test";
import assert from "node:assert/strict";
import {nativeInspection} from "../src/main/native-inspection";
const frame={width:800,height:600,dataURL:'data:image/png;base64,eA=='};
const element={role:'TextField',name:'Query',value:'Hello',focused:true,bounds:{left:60,top:110,width:100,height:30}};
test('Native accessibility returns actual image centers and bounded visible fields',()=>{
 const r=nativeInspection({elements:[element,{...element,bounds:{left:-10,top:590,width:100,height:50}}]},frame);
 assert.equal(r.available,true);assert.deepEqual(r.elements[0].click,{x:110,y:125});assert.equal(r.elements[0].value,'Hello');assert.equal(r.elements[0].focused,true);
 assert.deepEqual(r.elements[1].bounds,{left:0,top:590,width:90,height:10});assert.deepEqual(r.elements[1].click,{x:45,y:595});
});
test('Secure values, invalid bounds and unbounded native results never reach the model',()=>{
 const r=nativeInspection({elements:[{...element,value_redacted:true},{...element,role:'AXSecureTextField'},{...element,bounds:{left:900,top:0,width:10,height:10}},{...element,bounds:{left:NaN,top:0,width:10,height:10}}]},frame);
 assert.equal(r.elements.length,2);assert.ok(r.elements.every(e=>e.value_redacted&&e.value===undefined));
 assert.equal(nativeInspection({elements:Array.from({length:120},()=>({...element,name:'x'.repeat(500),value:'y'.repeat(6000)}))},frame).elements.length,100);
 assert.throws(()=>nativeInspection({elements:{}},frame));
});
