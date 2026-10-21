'use strict';
const codes={Enter:40,Escape:41,Backspace:42,Tab:43,Space:44,Minus:45,Equal:46,BracketLeft:47,BracketRight:48,Backslash:49,Semicolon:51,Quote:52,Backquote:53,Comma:54,Period:55,Slash:56,ArrowRight:79,ArrowLeft:80,ArrowDown:81,ArrowUp:82,NumpadDivide:84,NumpadMultiply:85,NumpadSubtract:86,NumpadAdd:87,NumpadEnter:88,Numpad0:98,NumpadDecimal:99,NumpadEqual:103};
for(let i=0;i<26;i++)codes['Key'+String.fromCharCode(65+i)]=4+i;
for(let i=1;i<=9;i++){codes['Digit'+i]=29+i;codes['Numpad'+i]=88+i;}codes.Digit0=39;
function chord(code,mods=[]){if(!Object.hasOwn(codes,code)||!Array.isArray(mods)||mods.some(m=>!['control','shift','option','command'].includes(m)))throw Error('Invalid keyboard chord');return [codes[code],mods.reduce((bits,m)=>bits|({control:1,shift:2,option:4,command:8}[m]),0)];}
// US-layout text → chords. Printable ASCII (0x20–0x7e) and newline only; any other character
// is not typeable here and the caller must use the pasteboard instead.
const unshifted="abcdefghijklmnopqrstuvwxyz1234567890 -=[]\\;'`,./";
const shifted="ABCDEFGHIJKLMNOPQRSTUVWXYZ!@#$%^&*() _+{}|:\"~<>?";
const textCodes=['KeyA','KeyB','KeyC','KeyD','KeyE','KeyF','KeyG','KeyH','KeyI','KeyJ','KeyK','KeyL','KeyM','KeyN','KeyO','KeyP','KeyQ','KeyR','KeyS','KeyT','KeyU','KeyV','KeyW','KeyX','KeyY','KeyZ',
 'Digit1','Digit2','Digit3','Digit4','Digit5','Digit6','Digit7','Digit8','Digit9','Digit0','Space','Minus','Equal','BracketLeft','BracketRight','Backslash','Semicolon','Quote','Backquote','Comma','Period','Slash'];
const textMap=new Map();
for(let i=0;i<textCodes.length;i++){textMap.set(unshifted[i],chord(textCodes[i]));if(shifted[i]!==' '||textCodes[i]!=='Space')textMap.set(shifted[i],chord(textCodes[i],['shift']));}
textMap.set('\n',chord('Enter'));
function typeable(text){return typeof text==='string'&&text.length>0&&[...text].every(c=>textMap.has(c));}
function textChords(text){if(!typeable(text))throw Error('Text is not typeable on a US keyboard');return [...text].map(c=>textMap.get(c));}
module.exports={chord,typeable,textChords};
