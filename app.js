import {loadImage, processImage, formatBytes, downloadBlob} from './image-engine.js';
import {createZip} from './zip.js';

const $ = id => document.getElementById(id);
const modes = {
  compress: {title:'图片压缩', description:'轻装上阵，分享不费劲', action:'开始压缩'},
  resize: {title:'调整尺寸', description:'每个位置，都有刚好的尺寸', action:'调整尺寸'},
  convert: {title:'格式转换', description:'换个格式，换种可能', action:'转换格式'},
  redact: {title:'隐私打码', description:'小秘密藏好，再放心分享', action:'生成打码图片'}
};
let mode='compress', items=[], selectedId=null, results=[], showingResult=false, busy=false, loading=false;
let toastTimer, dragStart=null, draft=null, ingestionVersion=0;
const current = () => items.find(item=>item.id===selectedId);
const resultFor = id => results.find(result=>result.id===id && result.blob);
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;$('toast').classList.toggle('error',error);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
function invalidate(){for(const r of results)if(r.url)URL.revokeObjectURL(r.url);results=[];$('results').hidden=true;showingResult=false;renderSizeComparison();}
function updateButton(){
  $('process-button').disabled=!items.length||busy||loading;
  $('process-label').textContent=loading?'正在读取图片…':modes[mode].action;
  $('selection-summary').textContent=`${items.length} 张图片`;
  $('button-note').textContent=items.length ? (mode==='redact'?'每张图片单独框选后，即可生成':'处理完成后，预览并下载图片'):'先选几张图片，我们马上开始';
  renderSizeComparison();
}
function renderFiles(){
  $('dropzone').hidden=items.length>0;$('loaded-state').hidden=!items.length;
  $('file-count').textContent=`${items.length} 张图片 · ${formatBytes(items.reduce((total,item)=>total+item.file.size,0))}`;
  $('thumbnail-list').replaceChildren();
  for(const item of items){
    const holder=document.createElement('div');holder.className='thumbnail-item'+(item.id===selectedId?' selected':'');
    const select=document.createElement('button');select.type='button';select.setAttribute('aria-label',`查看 ${item.name}`);select.setAttribute('aria-pressed',String(item.id===selectedId));
    const img=document.createElement('img');img.src=item.url;img.alt='';select.append(img);
    select.onclick=()=>{if(busy)return;selectedId=item.id;showingResult=false;syncDimensions();renderFiles();};
    const remove=document.createElement('button');remove.className='remove-file';remove.setAttribute('aria-label',`移除 ${item.name}`);remove.innerHTML='<svg aria-hidden="true"><use href="#i-close"/></svg>';
    remove.onclick=()=>{if(busy||loading)return;invalidate();URL.revokeObjectURL(item.url);items=items.filter(i=>i.id!==item.id);if(selectedId===item.id)selectedId=items[0]?.id??null;syncDimensions();renderFiles();};
    holder.append(select,remove);$('thumbnail-list').append(holder);
  }
  renderCurrent();updateButton();
}
function renderCurrent(){
  renderSizeComparison();
  const item=current();if(!item){$('preview-image').removeAttribute('src');return;}
  const output=showingResult?resultFor(item.id):null;
  $('preview-image').src=output?.url??item.url;
  $('preview-image').alt=output?'处理结果预览':'原图预览';
  $('current-name').textContent=output?.name??item.name;
  $('current-meta').textContent=`${output?.width??item.width} × ${output?.height??item.height} px · ${formatBytes(output?.blob.size??item.file.size)}`;
  const hasResult=!!resultFor(item.id);
  $('preview-badge').disabled=!hasResult;
  $('preview-badge').textContent=hasResult?(output?'处理后 · 点击查看原图':'原图 · 点击查看处理后'):(mode==='redact'?'拖动框选打码区域':'原图预览');
  $('redaction-canvas').hidden=mode!=='redact'||!!output;
  $('redact-help').hidden=mode!=='redact'||!!output;
  requestAnimationFrame(paintRedactions);
}
function renderSizeComparison(){
  const item=current(), result=item?resultFor(item.id):null;
  $('size-comparison').hidden=!item;$('size-change').hidden=!result;
  if(!item)return;
  $('before-label').textContent=mode==='compress'?'压缩前':'处理前';
  $('after-label').textContent=mode==='compress'?'压缩后':'处理后';
  $('size-before').textContent=formatBytes(item.file.size);
  $('size-before').title=`${item.file.size.toLocaleString('zh-CN')} 字节`;
  $('before-meta').textContent=`原始文件 · ${item.width} × ${item.height} px`;
  $('size-after').textContent=result?formatBytes(result.blob.size):'—';
  $('size-after').title=result?`${result.blob.size.toLocaleString('zh-CN')} 字节`:'';
  $('after-meta').textContent=result?`实际输出 · ${result.width} × ${result.height} px`:(busy?'正在处理…':mode==='compress'?'压缩完成后显示':'处理完成后显示');
  if(result){
    const difference=item.file.size-result.blob.size;
    const percent=Math.abs(difference)/item.file.size*100;
    const percentText=percent===0?'0':percent.toFixed(1);
    $('size-change').textContent=difference>0?`节省 ${formatBytes(difference)} · 减少 ${percentText}%`:difference<0?`增加 ${formatBytes(-difference)} · 增大 ${percentText}%`:'文件大小未变化';
    $('size-change').classList.toggle('increase',difference<0);
  }
}
async function ingest(files){
  if(busy||loading)return;
  const incoming=[...files];if(!incoming.length)return;
  loading=true;updateButton();const version=ingestionVersion;let added=0, errors=[];
  for(const file of incoming){
    if(items.length>=10){errors.push('一次最多处理 10 张图片');break;}
    if(items.reduce((sum,i)=>sum+i.file.size,0)+file.size>100*1024*1024){errors.push('本次图片总大小不能超过 100 MB');continue;}
    try{const item=await loadImage(file);if(version!==ingestionVersion){URL.revokeObjectURL(item.url);break;}item.redactions=[];items.push(item);added++;}
    catch(error){errors.push(`${file.name}：${error.message}`);}
  }
  loading=false;$('file-input').value='';
  if(added){invalidate();selectedId??=items[0].id;syncDimensions();renderFiles();}
  updateButton();
  if(errors.length)toast(errors.slice(0,2).join('；')+(errors.length>2?`（另有 ${errors.length-2} 个文件未添加）`:''),true);
  else if(added)toast(`已添加 ${added} 张图片，可以开始啦`);
}
$('choose-files').onclick=$('add-files').onclick=()=>{if(!busy&&!loading)$('file-input').click();};
$('file-input').onchange=e=>ingest(e.target.files);
$('clear-files').onclick=()=>{
  if(busy||loading)return;ingestionVersion++;invalidate();for(const item of items)URL.revokeObjectURL(item.url);items=[];selectedId=null;renderFiles();
};
let dragDepth=0;
function highlightDrop(active){$('dropzone').classList.toggle('drag-over',active);$('workbench').classList.toggle('drag-over',active);}
window.addEventListener('dragenter',e=>{if([...e.dataTransfer?.types??[]].includes('Files')){e.preventDefault();dragDepth++;highlightDrop(true);}});
window.addEventListener('dragover',e=>{e.preventDefault();if(e.dataTransfer)e.dataTransfer.dropEffect='copy';});
window.addEventListener('dragleave',e=>{e.preventDefault();dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)highlightDrop(false);});
window.addEventListener('drop',e=>{
  e.preventDefault();dragDepth=0;highlightDrop(false);
  if(busy||loading){toast('图片正在处理中，稍后再添加就好');return;}
  ingest(e.dataTransfer?.files??[]);
});
window.addEventListener('dragend',()=>{dragDepth=0;highlightDrop(false);});
document.addEventListener('paste',e=>{
  const pastedItems=[...(e.clipboardData?.items??[])];
  const itemFiles=pastedItems.filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
  const files=itemFiles.length?itemFiles:[...(e.clipboardData?.files??[])].filter(file=>file.type.startsWith('image/'));
  if(!files.length)return;
  e.preventDefault();
  if(busy||loading){toast('图片正在处理中，稍后再粘贴就好');return;}
  ingest(files);
});

function setMode(next){
  if(busy||loading)return;mode=next;invalidate();
  for(const tab of document.querySelectorAll('.tool-card')){const active=tab.dataset.mode===mode;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
  $('workbench').setAttribute('aria-labelledby',`tab-${mode}`);$('bench-title').textContent=modes[mode].title;$('bench-description').textContent=modes[mode].description;
  $('bench-icon').firstElementChild.setAttribute('href',`#i-${mode}`);
  $('compress-settings').hidden=mode==='resize'||mode==='redact';$('resize-settings').hidden=mode!=='resize';$('redact-settings').hidden=mode!=='redact';
  $('format-recommend').textContent=mode==='redact'?'推荐 PNG':'推荐 WebP';
  $('output-format').value=mode==='redact'?'image/png':'image/webp';
  syncDimensions();formatChanged(false);renderCurrent();updateButton();
}
document.querySelectorAll('.tool-card').forEach((tab,index)=>{
  tab.tabIndex=index===0?0:-1;tab.onclick=()=>setMode(tab.dataset.mode);
  tab.onkeydown=e=>{const tabs=[...document.querySelectorAll('.tool-card')];let next=index;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();if(busy||loading)return;setMode(tabs[next].dataset.mode);tabs[next].focus();};
});
function qualityChanged(){
  $('quality-label').textContent=`${$('quality').value}%`;
  for(const button of document.querySelectorAll('[data-quality]'))button.classList.toggle('selected',button.dataset.quality===$('quality').value);
  invalidate();renderCurrent();
}
$('quality').oninput=qualityChanged;
document.querySelectorAll('[data-quality]').forEach(button=>button.onclick=()=>{$('quality').value=button.dataset.quality;qualityChanged();});
function formatChanged(reset=true){
  const format=$('output-format').value;
  $('quality').disabled=format==='image/png';
  $('quality-label').textContent=format==='image/png'?'无损':`${$('quality').value}%`;
  document.querySelectorAll('[data-quality]').forEach(button=>button.disabled=format==='image/png');
  $('format-note').textContent=format==='image/png'?'无损保存，保留透明背景；画质滑块不影响 PNG。':format==='image/jpeg'?'兼容性好；透明区域会填充为白色。':'支持透明背景，适合网页和日常分享。';
  if(reset){invalidate();renderCurrent();}
}
$('output-format').onchange=()=>formatChanged();
function syncDimensions(){const item=current();if(item){$('resize-width').value=item.width;$('resize-height').value=item.height;}}
function dimensionChanged(axis){
  const item=current();if(item&&$('aspect-lock').checked){if(axis==='width')$('resize-height').value=Math.max(1,Math.round(Number($('resize-width').value)*item.height/item.width));else $('resize-width').value=Math.max(1,Math.round(Number($('resize-height').value)*item.width/item.height));}
  invalidate();renderCurrent();
}
$('resize-width').oninput=()=>dimensionChanged('width');$('resize-height').oninput=()=>dimensionChanged('height');
$('aspect-lock').onchange=()=>dimensionChanged('width');
document.querySelectorAll('[data-scale]').forEach(button=>button.onclick=()=>{const item=current();if(!item){toast('请先选择一张图片');return;}const scale=Number(button.dataset.scale);$('resize-width').value=Math.max(1,Math.round(item.width*scale));$('resize-height').value=Math.max(1,Math.round(item.height*scale));invalidate();renderCurrent();});
$('reset-settings').onclick=()=>{if(busy)return;$('quality').value='80';$('aspect-lock').checked=true;setMode(mode);qualityChanged();formatChanged(false);toast('设置已重置');};
$('preview-badge').onclick=()=>{showingResult=!showingResult;renderCurrent();};

// The overlay stores coordinates relative to the original image, not screen pixels.
function paintRedactions(){
  const canvas=$('redaction-canvas'),item=current();if(canvas.hidden||!item)return;
  const rect=$('preview-wrap').getBoundingClientRect();if(!rect.width||!rect.height)return;
  canvas.width=Math.round(rect.width*devicePixelRatio);canvas.height=Math.round(rect.height*devicePixelRatio);
  const ctx=canvas.getContext('2d');ctx.fillStyle='#172520';
  for(const r of [...item.redactions,...(draft?[draft]:[])])ctx.fillRect(r.x*canvas.width,r.y*canvas.height,r.w*canvas.width,r.h*canvas.height);
}
function pointerPosition(e){const rect=$('redaction-canvas').getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))};}
const overlay=$('redaction-canvas');
overlay.onpointerdown=e=>{if(busy||e.button!==0)return;invalidate();renderCurrent();overlay.setPointerCapture(e.pointerId);dragStart=pointerPosition(e);draft=null;e.preventDefault();};
overlay.onpointermove=e=>{if(!dragStart)return;const pos=pointerPosition(e);draft={x:Math.min(pos.x,dragStart.x),y:Math.min(pos.y,dragStart.y),w:Math.abs(pos.x-dragStart.x),h:Math.abs(pos.y-dragStart.y)};paintRedactions();};
overlay.onpointerup=e=>{if(!dragStart)return;const item=current();if(draft&&draft.w*item.width>=2&&draft.h*item.height>=2)item.redactions.push(draft);draft=null;dragStart=null;paintRedactions();if(overlay.hasPointerCapture(e.pointerId))overlay.releasePointerCapture(e.pointerId);};
overlay.onpointercancel=()=>{dragStart=null;draft=null;paintRedactions();};
new ResizeObserver(()=>paintRedactions()).observe($('preview-wrap'));
$('preview-image').onload=paintRedactions;
$('undo-redaction').onclick=()=>{if(busy||loading)return;current()?.redactions.pop();invalidate();renderCurrent();};
$('clear-redactions').onclick=()=>{if(busy||loading)return;if(current())current().redactions=[];invalidate();renderCurrent();};

$('process-button').onclick=async()=>{
  if(busy||loading||!items.length)return;
  const width=Number($('resize-width').value),height=Number($('resize-height').value);
  if(mode==='resize'&&(!Number.isInteger(width)||!Number.isInteger(height)||width<1||height<1||width>12000||height>12000)){toast('请输入 1–12000 之间的整数尺寸',true);return;}
  if(mode==='redact'&&!items.some(item=>item.redactions.length)){toast('先在预览图片上拖动，框选需要遮住的区域');return;}
  if(mode==='redact'&&items.some(item=>!item.redactions.length)){toast('有图片还没有打码区域，请逐张框选后再生成',true);return;}
  const options={mode,format:$('output-format').value,quality:Number($('quality').value)/100};
  const queue=items.map(item=>({item,redactions:item.redactions.map(rect=>({...rect})),targetHeight:mode==='resize'&&$('aspect-lock').checked?Math.max(1,Math.round(width*item.height/item.width)):height}));
  invalidate();busy=true;$('workbench').classList.add('busy');updateButton();
  document.querySelector('.settings').inert=true;document.querySelector('.editor-main').inert=true;document.querySelector('.tool-grid').inert=true;
  try{
    for(let i=0;i<queue.length;i++){
      const {item,redactions,targetHeight}=queue[i];$('process-label').textContent=`处理中 ${i+1} / ${queue.length}`;
      await new Promise(resolve=>setTimeout(resolve,20));
      try{
        const output=await processImage(item,{...options,width,height:targetHeight,redactions});
        results.push({...output,id:item.id,url:URL.createObjectURL(output.blob)});
      }catch(error){results.push({id:item.id,name:item.name,error:error.message});}
    }
    renderResults();showingResult=!!resultFor(selectedId);renderCurrent();
    const count=results.filter(r=>r.blob).length;toast(count?`${count} 张图片处理完成，预览后就能下载`:results[0]?.error??'处理失败，请换一张图片试试',!count);
  }finally{busy=false;$('workbench').classList.remove('busy');document.querySelector('.settings').inert=false;document.querySelector('.editor-main').inert=false;document.querySelector('.tool-grid').inert=false;updateButton();}
};
function renderResults(){
  $('results').hidden=!results.length;$('result-list').replaceChildren();
  $('download-all').hidden=!results.some(r=>r.blob);
  for(const result of results){
    const row=document.createElement('div');row.className='result-row';
    if(result.blob){const thumb=document.createElement('img');thumb.src=result.url;thumb.alt='处理后缩略图';thumb.className='result-thumb';row.append(thumb);}
    const text=document.createElement('div');text.className='result-text';const name=document.createElement('strong');name.textContent=result.name;const meta=document.createElement('small');
    if(result.error){meta.textContent=result.error;meta.className='result-error';}
    else meta.textContent=`${result.width} × ${result.height} px`;
    text.append(name,meta);row.append(text);
    if(result.blob){
      const sizeGrid=document.createElement('div');sizeGrid.className='result-size-grid';
      for(const [label,bytes] of [[mode==='compress'?'压缩前':'处理前',result.originalSize],[mode==='compress'?'压缩后':'处理后',result.blob.size]]){
        const cell=document.createElement('div');cell.className='result-size-cell';const caption=document.createElement('label');caption.textContent=label;const value=document.createElement('strong');value.textContent=formatBytes(bytes);value.title=`${bytes.toLocaleString('zh-CN')} 字节`;cell.append(caption,value);sizeGrid.append(cell);
      }
      text.append(sizeGrid);
      const delta=1-result.blob.size/result.originalSize;const saving=document.createElement('span');saving.className='saving';saving.textContent=delta>0?`减少 ${(delta*100).toFixed(1)}%`:delta<0?`增加 ${(-delta*100).toFixed(1)}%`:'大小未变';saving.classList.toggle('increase',delta<0);row.append(saving);
      const preview=document.createElement('button');preview.className='text-button';preview.textContent='预览';preview.onclick=()=>{selectedId=result.id;showingResult=true;renderFiles();};
      const download=document.createElement('button');download.className='download-one';download.setAttribute('aria-label',`下载 ${result.name}`);download.innerHTML='<svg aria-hidden="true"><use href="#i-download"/></svg>';download.onclick=()=>downloadBlob(result.blob,result.name);row.append(preview,download);
    }
    $('result-list').append(row);
  }
}
$('download-all').onclick=async()=>{
  const button=$('download-all');button.disabled=true;
  try{const valid=results.filter(r=>r.blob);if(!valid.length)return;const zip=await createZip(valid);downloadBlob(zip,'图片急救站-处理结果.zip');toast('打包完成，已开始下载');}
  catch(error){toast(`打包失败：${error.message}`,true);}finally{button.disabled=false;}
};
$('try-sample').onclick=async()=>{
  if(busy||loading)return;
  const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=1200;const ctx=canvas.getContext('2d');
  const sky=ctx.createLinearGradient(0,0,0,1200);sky.addColorStop(0,'#4ddbd9');sky.addColorStop(1,'#eef1ff');ctx.fillStyle=sky;ctx.fillRect(0,0,1800,1200);
  ctx.fillStyle='#4ddbb6';ctx.beginPath();ctx.arc(1380,270,130,0,2*Math.PI);ctx.fill();
  ctx.fillStyle='#4db9db';ctx.beginPath();ctx.moveTo(0,950);ctx.lineTo(600,175);ctx.lineTo(1200,1000);ctx.lineTo(1510,490);ctx.lineTo(1800,850);ctx.lineTo(1800,1200);ctx.lineTo(0,1200);ctx.fill();
  ctx.fillStyle='#f5f7ff';ctx.beginPath();ctx.moveTo(385,455);ctx.lineTo(600,175);ctx.lineTo(820,478);ctx.lineTo(685,428);ctx.lineTo(610,485);ctx.lineTo(520,400);ctx.fill();
  ctx.fillStyle='#4d96db';ctx.beginPath();ctx.moveTo(0,875);ctx.bezierCurveTo(600,650,950,1140,1800,890);ctx.lineTo(1800,1200);ctx.lineTo(0,1200);ctx.fill();
  ctx.fillStyle='#4d4fdb';ctx.beginPath();ctx.moveTo(0,1090);ctx.bezierCurveTo(650,840,1150,1270,1800,1050);ctx.lineTo(1800,1200);ctx.lineTo(0,1200);ctx.fill();
  ctx.fillStyle='#6f4ddb';ctx.beginPath();ctx.moveTo(920,920);ctx.lineTo(1080,1200);ctx.lineTo(825,1200);ctx.lineTo(865,945);ctx.fill();
  ctx.fillStyle='#ffffffb3';ctx.font='26px sans-serif';ctx.fillText('A LITTLE ROOM TO BREATHE.',78,1110);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob){toast('当前浏览器无法生成示例图片',true);return;}await ingest([new File([blob],'山野来信-示例.png',{type:'image/png'})]);
};
window.addEventListener('beforeunload',()=>{for(const item of items)URL.revokeObjectURL(item.url);for(const r of results)if(r.url)URL.revokeObjectURL(r.url);});
updateButton();
