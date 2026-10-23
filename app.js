import {loadImage, processImage, formatBytes, downloadBlob} from './image-engine.js?v=2.1.0';
import {createZip} from './zip.js?v=2.1.0';
const $=id=>document.getElementById(id);
const modes={
 compress:{title:'图片压缩',description:'选图片，看实际大小，再决定怎么压。',action:'开始压缩'},
 resize:{title:'调整尺寸',description:'统一宽度，或自定义宽高。',action:'生成新尺寸'},
 convert:{title:'格式转换',description:'转换为 JPG、PNG 或 WebP。',action:'开始转换'},
 redact:{title:'隐私打码',description:'逐张框选遮挡区域，预览后再分享。',action:'生成打码图片'}
};
const defaults={
 compress:{quality:80,format:'original',strategy:'quality',target:200,unit:'KB',allowResize:true},
 resize:{quality:92,format:'original',width:1200,height:800,lock:true,initialized:false},
 convert:{quality:92,format:'image/jpeg'},redact:{quality:92,format:'image/png'}
};
const settings=Object.fromEntries(Object.entries(defaults).map(([key,value])=>[key,{...value}]));
const outputs=Object.fromEntries(Object.keys(modes).map(key=>[key,new Map()]));
let mode='compress',items=[],selectedId=null,showingResult=false,busy=false,loading=false,packing=false;
let toastTimer,dragStart=null,draft=null,cancelRequested=false,zoomScale=1,zoomDrawing=false,lastFocus;
const current=()=>items.find(item=>item.id===selectedId);
const state=()=>settings[mode];
const saved=id=>outputs[mode].get(id);
const resultFor=id=>{const r=saved(id);return r?.blob?r:null;};
const allOutputs=()=>items.map(item=>saved(item.id)).filter(Boolean);
const usableOutputs=()=>allOutputs().filter(r=>r.blob);
const imageType=item=>item?.sourceType||item?.file.type||'image/png';
const resolvedType=(item,format=state().format)=>format==='original'?(['image/jpeg','image/png','image/webp'].includes(imageType(item))?imageType(item):'image/png'):format;
function fingerprint(item){
 const s=state(),options={mode,format:s.format,quality:mode==='compress'&&s.strategy==='target'?95:s.quality};
 if(mode==='compress'){options.strategy=s.strategy;if(s.strategy==='target')Object.assign(options,{target:String(s.target),unit:s.unit,allowResize:s.allowResize});}
 if(mode==='resize')Object.assign(options,{width:s.width,height:s.lock?null:s.height,lock:s.lock});
 if(mode==='redact')options.redactions=item.redactions;
 return JSON.stringify(options);
}
const fresh=(item,r=saved(item.id))=>!!r?.blob&&!r.error&&r.signature===fingerprint(item);
function toast(message,error=false){clearTimeout(toastTimer);$('toast').textContent=message;$('toast').hidden=false;$('toast').classList.toggle('error',error);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
function feedback(title,messages=[],type='warning'){
 $('feedback-title').textContent=title;$('feedback-details').replaceChildren();
 for(const message of messages){const line=document.createElement('li');line.textContent=message;$('feedback-details').append(line);}
 $('feedback').dataset.type=type;$('feedback').hidden=false;
}
$('dismiss-feedback').onclick=()=>$('feedback').hidden=true;
function revokeResult(r){if(r?.url)URL.revokeObjectURL(r.url);}
function releaseItem(item){URL.revokeObjectURL(item.url);if(item.image)item.image.src='';}
function settingsChanged(){if(busy||loading)return;showingResult=false;renderAll();}
function updateButton(){
 $('process-button').disabled=!items.length||busy||loading;
 $('process-label').textContent=loading?'正在读取图片…':busy?'正在处理…':modes[mode].action+(items.length>1?' '+items.length+' 张':'');
 $('selection-summary').textContent=items.length+' 张 · '+formatBytes(items.reduce((n,item)=>n+item.file.size,0));
 $('button-note').textContent=!items.length?'先添加图片，也可以试用示例':mode==='redact'?'每张图片都需要框选；生成后请检查遮挡效果':mode==='compress'&&state().strategy==='target'?'目标大小会尽量满足，实际结果以生成文件为准':'设置会保留，查看其他图片不会重置';
 $('mobile-download-button').hidden=!usableOutputs().length||busy||loading;
 $('mobile-download-button').textContent=packing?'正在打包…':usableOutputs().length===1?'下载图片':'下载 ZIP';$('mobile-download-button').disabled=packing;
 $('add-files').disabled=$('clear-files').disabled=$('choose-files').disabled=$('try-sample').disabled=busy||loading;
 document.body.classList.toggle('has-images',items.length>0);document.body.classList.toggle('processing',busy);
}
function renderFiles(){
 $('dropzone').hidden=items.length>0;$('loaded-state').hidden=!items.length;
 $('file-count').textContent=items.length+' 张图片 · '+formatBytes(items.reduce((n,item)=>n+item.file.size,0));
 const list=$('thumbnail-list');list.replaceChildren();
 for(const item of items){
  const holder=document.createElement('div');holder.className='thumbnail-item'+(item.id===selectedId?' selected':'');
  const select=document.createElement('button');select.type='button';select.className='thumbnail-select';select.disabled=busy||loading;
  select.setAttribute('aria-label','查看 '+item.name);select.setAttribute('aria-pressed',String(item.id===selectedId));
  const img=document.createElement('img');img.src=item.url;img.alt='';select.append(img);
  const label=document.createElement('span');label.className='thumbnail-status';
  label.textContent=mode==='redact'?(item.redactions.length?'已遮挡 '+item.redactions.length+' 处':'待框选'):fresh(item)?'已完成':resultFor(item.id)?'上次结果':'待处理';select.append(label);
  select.onclick=()=>{if(busy||loading)return;selectedId=item.id;showingResult=false;renderAll();};
  const remove=document.createElement('button');remove.type='button';remove.className='remove-file';remove.disabled=busy||loading;
  remove.setAttribute('aria-label','移除 '+item.name);remove.innerHTML='<svg aria-hidden="true"><use href="#i-close"/></svg>';
  remove.onclick=()=>{
   if(busy||loading)return;
   for(const map of Object.values(outputs)){revokeResult(map.get(item.id));map.delete(item.id);}
   releaseItem(item);items=items.filter(other=>other.id!==item.id);if(selectedId===item.id)selectedId=items[0]?.id??null;
   showingResult=false;renderAll();
  };
  holder.append(select,remove);list.append(holder);
 }
}
function renderSizeComparison(){
 const item=current(),r=item?resultFor(item.id):null;$('size-comparison').hidden=!item;$('size-change').hidden=!r;
 if(!item)return;
 $('before-label').textContent=mode==='compress'?'压缩前':'处理前';$('after-label').textContent=mode==='compress'?'压缩后':'处理后';
 $('size-before').textContent=formatBytes(item.file.size);$('size-before').title=item.file.size.toLocaleString('zh-CN')+' 字节';
 $('before-meta').textContent=item.width+' × '+item.height+' px · 原始文件';
 $('size-after').textContent=r?formatBytes(r.blob.size):'—';$('size-after').title=r?r.blob.size.toLocaleString('zh-CN')+' 字节':'';
 $('after-meta').textContent=r?r.width+' × '+r.height+' px · '+(fresh(item,r)?'实际输出':'上次结果，待重新处理'):busy?'正在生成实际结果…':'处理后显示实际大小';
 if(r){
  const delta=item.file.size-r.blob.size,percentage=Math.abs(delta)/item.file.size*100;
  let text=delta>0?'减少 '+formatBytes(delta)+' · '+percentage.toFixed(1)+'%':delta<0?'增加 '+formatBytes(-delta)+' · '+percentage.toFixed(1)+'%':'大小未变：原图已经很精简';
  if(r.targetMet===false)text+=' · 未达到 '+formatBytes(r.targetBytes)+' 目标';
  if(r.resized)text+=' · 已缩小尺寸';if(!fresh(item,r))text='上次结果 · '+text;
  $('size-change').textContent=text;$('size-change').classList.toggle('increase',delta<0||r.targetMet===false);
 }
}
function renderCurrent(){
 const item=current();if(!item){$('preview-image').removeAttribute('src');$('current-name').textContent='';$('current-meta').textContent='';closeZoom();return;}
 const r=resultFor(item.id),output=showingResult?r:null;
 $('copy-preview-image').textContent=output?'复制图片':'复制原图';$('copy-preview-image').disabled=busy||loading||(mode==='redact'&&!output);$('copy-preview-image').title=mode==='redact'&&!output?'请先生成打码结果，再复制图片':'';
 $('preview-image').src=output?.url??item.url;$('preview-image').alt=output?'处理后图片预览':'原始图片预览';
 $('current-name').textContent=output?.name??item.name;
 $('current-meta').textContent=(output?.width??item.width)+' × '+(output?.height??item.height)+' px · '+formatBytes(output?.blob.size??item.file.size);
 $('preview-original').setAttribute('aria-pressed',String(!output));$('preview-result').setAttribute('aria-pressed',String(!!output));
 $('preview-result').disabled=!r;$('preview-result').textContent=r&&!fresh(item,r)?'上次结果':'处理后';
 $('preview-badge').textContent=output?(fresh(item,r)?'处理后':'上次结果'):mode==='redact'?'原图 · 拖动框选':'原图';
 $('redaction-canvas').hidden=mode!=='redact'||!!output;$('redact-help').hidden=mode!=='redact'||!!output;
 $('undo-redaction').disabled=$('clear-redactions').disabled=busy||!item.redactions.length;
 const warnings=[];if(imageType(item)==='image/gif')warnings.push('GIF 会导出为静态图片，不保留动画。');
 if(output?.reusedOriginal)warnings.push('原图已较小，保留原文件，大小与画质均未改变。');
 $('current-warning').textContent=warnings.join(' ');$('current-warning').hidden=!warnings.length;
 requestAnimationFrame(paintRedactions);if($('zoom-dialog').open)renderZoom();
}
function syncSettings(){
 const s=state(),item=current();
 $('compress-settings').hidden=mode!=='compress';$('resize-settings').hidden=mode!=='resize';$('redact-settings').hidden=mode!=='redact';
 $('output-format').value=s.format;$('quality').value=String(s.quality);
 const types=items.length?items.map(image=>resolvedType(image)):[resolvedType(item)],lossless=types.every(type=>type==='image/png'),target=mode==='compress'&&s.strategy==='target';
 $('quality-controls').hidden=target;$('use-webp').hidden=mode!=='compress'||!lossless;$('quality').disabled=lossless;$('quality-label').textContent=lossless?'PNG 无损编码':s.quality+' / 100';
 for(const button of document.querySelectorAll('[data-quality]')){button.disabled=lossless;button.classList.toggle('selected',Number(button.dataset.quality)===s.quality);}
 $('compression-strategy').value=settings.compress.strategy;$('target-settings').hidden=!target;
 $('target-size').value=String(settings.compress.target);$('target-unit').value=settings.compress.unit;$('allow-target-resize').checked=settings.compress.allowResize;
 $('format-recommend').textContent=s.format==='original'?'保持输入格式':s.format==='image/jpeg'?'兼容性好':s.format==='image/png'?'保留透明':'兼顾大小与透明';
 $('format-note').textContent=s.format==='original'?'JPG、PNG、WebP 保持格式；GIF、BMP 转为静态 PNG。PNG 需缩尺寸或换 WebP 才能明显减小。':s.format==='image/jpeg'?'适合照片和常用表单；透明区域将填充白色。':s.format==='image/png'?'保留透明背景；画质滑块不会改变 PNG，文件可能比原图大。':'支持透明背景；某些老软件和上传表单不接受 WebP，可改选 JPG。';
 const resize=settings.resize;$('resize-width').value=String(resize.width);
 $('resize-height').value=String(resize.lock&&item?Math.max(1,Math.round(resize.width*item.height/item.width)):resize.height);$('aspect-lock').checked=resize.lock;
 $('resize-summary').textContent=resize.lock?'所有图片统一宽度 '+(resize.width||'—')+' px，高度按各自原图比例计算。':'所有图片输出 '+(resize.width||'—')+' × '+(resize.height||'—')+' px，可能改变原图比例。';
}
const PUBLIC_IMAGE_ORIGIN='https://image-aid-studio-edy.soundbat1024.chatgpt.site';
const publicImageQueue=[];
let publicImageActive=0;
// PNG is supported by more clipboard implementations than JPEG or WebP.
// Pass the conversion promise directly so the write starts during the click.
async function pngClipboardBlob(blob){
 if(blob.type==='image/png')return blob;
 const canvas=document.createElement('canvas'),image=new Image(),url=URL.createObjectURL(blob);
 try{
  await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('图片读取失败，请下载后复制'));image.src=url;});
  canvas.width=image.naturalWidth||image.width;canvas.height=image.naturalHeight||image.height;
  if(!canvas.width||!canvas.height)throw new Error('图片尺寸读取失败，请下载后复制');
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('当前浏览器无法准备复制图片');
  ctx.drawImage(image,0,0);
  const png=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
  if(!png||png.type!=='image/png')throw new Error('图片复制准备失败，请下载后复制');
  return png;
 }finally{canvas.width=0;canvas.height=0;image.src='';URL.revokeObjectURL(url);}
}
async function copyImage(blob,button){
 if(!blob)return false;
 if(!globalThis.isSecureContext||!navigator.clipboard?.write||!globalThis.ClipboardItem){
  toast('当前浏览器不支持复制图片，请下载图片，或在大图上长按／右键复制',true);return false;
 }
 const previousLabel=button?.textContent;
 if(button){button.disabled=true;button.textContent='正在复制…';}
 try{
  const png=pngClipboardBlob(blob);png.catch(()=>{});
  await navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
  toast('图片已复制，可以粘贴到聊天或文档');return true;
 }catch(error){
  toast(error.name==='NotAllowedError'?'浏览器未允许复制图片，请在大图上长按／右键复制，或下载后复制':'图片复制未完成，请在大图上长按／右键复制，或下载后复制',true);return false;
 }finally{if(button){button.disabled=busy||loading;button.textContent=previousLabel;}}
}
function copyCurrentImage(button){
 const item=current(),output=showingResult?resultFor(selectedId):null;if(!item)return;
 if(mode==='redact'&&!output){toast('请先生成打码图片，再复制处理结果');return;}
 return copyImage(output?.blob??item.file,button);
}
async function copyPublicImageUrl(url,input){
 try{
  if(!navigator.clipboard?.writeText)throw new Error('clipboard-unavailable');
  await navigator.clipboard.writeText(url);toast('图片 URL 已复制');
 }catch{
  input?.focus();input?.select();toast('未能自动复制，链接已选中，请手动复制',true);
 }
}
function validatedPublicImageUrl(value){
 if(typeof value!=='string')throw new Error('服务没有返回可用的图片 URL');
 const url=new URL(value);
 if(url.protocol!=='https:'||url.origin!==PUBLIC_IMAGE_ORIGIN||!url.pathname.startsWith('/images/')||url.pathname==='/images/'||url.username||url.password||url.search||url.hash)throw new Error('服务返回的图片 URL 无效，请重试');
 return url.href;
}
async function uploadPublicImage(r){
 let controller,timer;
 try{
  if(!globalThis.AbortController||!globalThis.fetch)throw new Error('当前浏览器不支持生成图片 URL，请换用新版浏览器；仍可复制或下载图片。');
  controller=new AbortController();timer=setTimeout(()=>controller.abort(),30000);
  const response=await fetch(PUBLIC_IMAGE_ORIGIN+'/api/images',{method:'POST',headers:{'Content-Type':r.blob.type},body:r.blob,credentials:'omit',signal:controller.signal});
  if(!response.ok)throw new Error('公开存储暂时不可用（HTTP '+response.status+'），请重试');
  const data=await response.json();r.publicUrl=validatedPublicImageUrl(data.url);r.publicError='';return r.publicUrl;
 }catch(error){
  r.publicError=error.name==='AbortError'?'图片 URL 生成超时，请检查网络后重试':error instanceof TypeError?'无法连接图片存储，你的网络可能拦截了该域名。请换网络后重试；仍可复制或下载图片。':error.message||'图片 URL 生成失败，请重试';
  return null;
 }finally{clearTimeout(timer);}
}
function drainPublicImageQueue(){
 while(publicImageActive<2&&publicImageQueue.length){
  const {result,resolve}=publicImageQueue.shift();publicImageActive++;
  uploadPublicImage(result).then(resolve).finally(()=>{
   result.publishing=false;result.publicTask=null;publicImageActive--;renderResults();drainPublicImageQueue();
  });
 }
}
function publishPublicImage(r){
 if(!r?.blob)return Promise.resolve(null);
 if(r.publicUrl)return Promise.resolve(r.publicUrl);
 if(r.publicTask)return r.publicTask;
 r.publishing=true;r.publicError='';
 r.publicTask=new Promise(resolve=>publicImageQueue.push({result:r,resolve}));
 drainPublicImageQueue();renderResults();return r.publicTask;
}
function publicImageControls(r){
 const group=document.createElement('section');group.className='public-image-controls';group.setAttribute('aria-label','处理后图片 URL');
 const caption=document.createElement('strong');caption.className='public-url-label';caption.textContent='图片 URL';group.append(caption);
 if(r.publicUrl){
  const box=document.createElement('div');box.className='public-image-urlbox';
  const input=document.createElement('input');input.type='url';input.readOnly=true;input.value=r.publicUrl;input.setAttribute('aria-label',r.name+' 的图片 URL');input.spellcheck=false;input.onclick=()=>input.select();
  const copy=document.createElement('button');copy.type='button';copy.className='secondary copy-image-url';copy.textContent='复制链接';copy.onclick=()=>copyPublicImageUrl(r.publicUrl,input);
  const open=document.createElement('a');open.className='text-button open-image-url';open.href=r.publicUrl;open.target='_blank';open.rel='noopener noreferrer';open.textContent='打开图片';open.setAttribute('aria-label','在新标签页打开 '+r.name);
  box.append(input,copy,open);group.append(box);
 }else{
  const line=document.createElement('div');line.className='public-image-status';
  const status=document.createElement('span');status.setAttribute('role','status');status.textContent=r.publishing?'正在生成图片 URL…':r.publicError||'正在准备图片 URL…';status.className=r.publicError?'public-url-error':'public-url-progress';line.append(status);
  if(!r.publishing){const retry=document.createElement('button');retry.type='button';retry.className='secondary publish-image-url';retry.textContent=r.publicError?'重试生成链接':'生成图片链接';retry.onclick=()=>publishPublicImage(r);line.append(retry);}
  group.append(line);
 }
 return group;
}
function openResultPreview(id){
 if(busy||loading)return;
 selectedId=id;showingResult=true;renderAll();openZoom();
}
function renderResults(){
 const results=allOutputs(),ready=results.filter(r=>r.blob),failures=results.filter(r=>r.error),pending=items.filter(item=>!fresh(item)).length;
 $('results').hidden=!results.length;$('result-list').replaceChildren();
 $('results-title').textContent=failures.length?(ready.length?failures.length+' 张未成功，请检查':'处理未成功'):pending?'已有处理结果':ready.length+' 张图片处理完成';
 $('results-title').classList.toggle('has-error',failures.length>0);
 let summary='';
 if(ready.length){
  const before=ready.reduce((n,r)=>n+r.originalSize,0),after=ready.reduce((n,r)=>n+r.blob.size,0);
  summary='可下载 '+ready.length+' 张 · '+formatBytes(before)+' → '+formatBytes(after);
  summary+=after<before?' · 共节省 '+formatBytes(before-after):after>before?' · 共增加 '+formatBytes(after-before):' · 总大小未变';
 }
 if(pending)summary+=(summary?'；':'')+pending+' 张需要按当前设置处理';
 $('results-summary').textContent=summary;$('retry-failed').hidden=!failures.length||busy;
 $('download-all').hidden=!ready.length;$('download-all').disabled=busy||packing;
 $('download-all').textContent=packing?'正在打包…':ready.length===1?'下载图片 · '+formatBytes(ready[0].blob.size):'下载全部 '+ready.length+' 张（ZIP）';
 for(const r of results){
  const item=items.find(i=>i.id===r.id),stale=!fresh(item,r),row=document.createElement('article');row.className='result-row'+(stale?' stale':'')+(r.error?' failed':'');
  if(r.blob){const previewButton=document.createElement('button');previewButton.type='button';previewButton.className='result-thumb-button';previewButton.disabled=busy||loading;previewButton.setAttribute('aria-label','放大查看 '+r.name);previewButton.title='点击图片放大查看';previewButton.onclick=()=>openResultPreview(item.id);const img=document.createElement('img');img.className='result-thumb';img.src=r.url;img.alt='';previewButton.append(img);row.append(previewButton);}
  const text=document.createElement('div');text.className='result-text';const name=document.createElement('strong');name.textContent=r.name||item.name;text.append(name);
  const meta=document.createElement('small');meta.textContent=r.error?r.error:r.blob?r.width+' × '+r.height+' px'+(stale?' · 上次结果，设置已更改':''):'未完成';if(r.error)meta.className='result-error';text.append(meta);
  if(r.blob){
   const grid=document.createElement('div');grid.className='result-size-grid';
   for(const [label,bytes] of [[mode==='compress'?'压缩前':'处理前',r.originalSize],[mode==='compress'?'压缩后':'处理后',r.blob.size]]){
    const cell=document.createElement('div');cell.className='result-size-cell';const caption=document.createElement('span');caption.textContent=label;
    const value=document.createElement('strong');value.textContent=formatBytes(bytes);value.title=bytes.toLocaleString('zh-CN')+' 字节';cell.append(caption,value);grid.append(cell);
   }
   text.append(grid);
   if(r.targetMet===false||r.resized||r.reusedOriginal){
    const note=document.createElement('small');note.className='result-warning';
    note.textContent=[r.targetMet===false?'未达到 '+formatBytes(r.targetBytes)+'，可换用 WebP 或调高目标':null,r.resized?'已等比缩小尺寸':null,r.reusedOriginal?'保留原文件':null].filter(Boolean).join(' · ');text.append(note);
   }
   const delta=1-r.blob.size/r.originalSize,badge=document.createElement('span');badge.className='saving'+(delta<0?' increase':'');
   badge.textContent=delta>0?'减少 '+(delta*100).toFixed(1)+'%':delta<0?'增加 '+(-delta*100).toFixed(1)+'%':'大小未变';text.append(badge);
  }
  row.append(text);const actions=document.createElement('div');actions.className='result-actions';
  if(r.blob){
   const preview=document.createElement('button');preview.type='button';preview.className='text-button result-preview';preview.textContent='放大查看';preview.disabled=busy;
   preview.onclick=()=>openResultPreview(item.id);
   const copy=document.createElement('button');copy.type='button';copy.className='secondary copy-result';copy.textContent='复制图片';copy.disabled=busy||loading;copy.onclick=()=>copyImage(r.blob,copy);const download=document.createElement('button');download.type='button';download.className='download-result';download.textContent=stale?'下载上次结果':'下载图片';download.disabled=busy;
   download.setAttribute('aria-label','下载 '+r.name);download.onclick=()=>{downloadBlob(r.blob,r.name);if(stale)toast('已下载上次结果，重新处理可应用当前设置');};actions.append(preview,copy,download);
  }else{const retry=document.createElement('button');retry.type='button';retry.className='text-button';retry.textContent='重试';retry.disabled=busy;retry.onclick=()=>runBatch([item.id]);actions.append(retry);}
  row.append(actions);if(r.blob)row.append(publicImageControls(r));$('result-list').append(row);
 }
}
function renderAll(){syncSettings();renderFiles();renderCurrent();renderSizeComparison();renderResults();updateButton();}
async function ingest(files){
 if(busy||loading)return;const incoming=[...files];if(!incoming.length)return;
 loading=true;updateButton();let added=0;const errors=[];
 try{
  for(const file of incoming){
   if(items.length>=10){errors.push('一次最多 10 张图片，剩余图片请分批添加。');break;}
   if(items.reduce((n,i)=>n+i.file.size,0)+file.size>100*1024*1024){errors.push(file.name+'：本批总文件大小超过 100 MB，请分批处理。');continue;}
   try{
    const item=await loadImage(file);
    if(items.reduce((n,i)=>n+i.width*i.height,0)+item.width*item.height>60000000){releaseItem(item);errors.push(file.name+'：本批合计超过 6000 万像素，请减少图片数量后分批处理。');continue;}
    item.redactions=[];items.push(item);selectedId??=item.id;added++;
   }catch(error){errors.push((file.name||'图片')+'：'+error.message);}
  }
  if(items.length&&!settings.resize.initialized){settings.resize.width=items[0].width;settings.resize.height=items[0].height;settings.resize.initialized=true;}
 }finally{loading=false;$('file-input').value='';renderAll();}
 if(errors.length)feedback(added?'已添加 '+added+' 张，另有图片未添加':'图片未添加成功',errors,'error');else if(added)toast('已添加 '+added+' 张图片');
}
$('choose-files').onclick=$('add-files').onclick=()=>{if(!busy&&!loading)$('file-input').click();};
$('file-input').onchange=e=>ingest(e.target.files);
$('clear-files').onclick=()=>{
 if(busy||loading)return;for(const map of Object.values(outputs)){for(const r of map.values())revokeResult(r);map.clear();}
 items.forEach(releaseItem);items=[];selectedId=null;showingResult=false;$('feedback').hidden=true;renderAll();
};
let dragDepth=0;const isFileDrag=e=>[...(e.dataTransfer?.types??[])].includes('Files');
function highlightDrop(active){$('dropzone').classList.toggle('drag-over',active);$('workbench').classList.toggle('drag-over',active);}
window.addEventListener('dragenter',e=>{if(isFileDrag(e)){e.preventDefault();dragDepth++;highlightDrop(true);}});
window.addEventListener('dragover',e=>{if(isFileDrag(e)){e.preventDefault();e.dataTransfer.dropEffect='copy';}});
window.addEventListener('dragleave',e=>{if(isFileDrag(e)){dragDepth=Math.max(0,dragDepth-1);if(!dragDepth)highlightDrop(false);}});
window.addEventListener('drop',e=>{if(!e.dataTransfer?.files.length)return;e.preventDefault();dragDepth=0;highlightDrop(false);if(busy||loading){toast('正在处理图片，请完成后再添加');return;}ingest(e.dataTransfer.files);});
window.addEventListener('dragend',()=>{dragDepth=0;highlightDrop(false);});
document.addEventListener('paste',e=>{
 if($('zoom-dialog').open)return;
 const entries=[...(e.clipboardData?.items??[])],pasted=entries.filter(item=>item.kind==='file'&&item.type.startsWith('image/')).map(item=>item.getAsFile()).filter(Boolean);
 const files=pasted.length?pasted:[...(e.clipboardData?.files??[])].filter(file=>file.type.startsWith('image/'));
 if(!files.length)return;e.preventDefault();if(busy||loading){toast('正在处理图片，请完成后再粘贴');return;}ingest(files);
});
function setMode(next){
 if(busy||loading||next===mode)return;closeZoom();mode=next;showingResult=false;
 for(const tab of document.querySelectorAll('.tool-card')){const active=tab.dataset.mode===mode;tab.classList.toggle('active',active);tab.setAttribute('aria-selected',String(active));tab.tabIndex=active?0:-1;}
 $('workbench').setAttribute('aria-labelledby','tab-'+mode);$('bench-title').textContent=modes[mode].title;$('bench-description').textContent=modes[mode].description;
 $('bench-icon').firstElementChild.setAttribute('href','#i-'+mode);renderAll();
}
document.querySelectorAll('.tool-card').forEach((tab,index)=>{
 tab.tabIndex=index?-1:0;tab.onclick=()=>setMode(tab.dataset.mode);
 tab.onkeydown=e=>{
  const tabs=[...document.querySelectorAll('.tool-card')];let next=index;
  if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;
  e.preventDefault();if(busy||loading)return;setMode(tabs[next].dataset.mode);tabs[next].focus();
 };
});
$('quality').oninput=()=>{if(busy||loading)return;state().quality=Number($('quality').value);settingsChanged();};
document.querySelectorAll('[data-quality]').forEach(button=>button.onclick=()=>{if(busy||loading)return;state().quality=Number(button.dataset.quality);settingsChanged();});
$('use-webp').onclick=()=>{if(busy||loading)return;state().format='image/webp';settingsChanged();};
$('output-format').onchange=()=>{if(busy||loading)return;state().format=$('output-format').value;settingsChanged();};
$('compression-strategy').onchange=()=>{if(busy||loading)return;settings.compress.strategy=$('compression-strategy').value;settingsChanged();};
$('target-size').oninput=()=>{if(busy||loading)return;settings.compress.target=$('target-size').value;settingsChanged();};
$('target-unit').onchange=()=>{if(busy||loading)return;settings.compress.unit=$('target-unit').value;settingsChanged();};
$('allow-target-resize').onchange=()=>{if(busy||loading)return;settings.compress.allowResize=$('allow-target-resize').checked;settingsChanged();};
function dimensionChanged(axis){
 if(busy||loading)return;
 const s=settings.resize,item=current(),value=Number($(axis==='width'?'resize-width':'resize-height').value);
 if(axis==='width')s.width=value;else s.height=value;
 if(item&&s.lock&&Number.isFinite(value)&&value>0){if(axis==='height')s.width=Math.max(1,Math.round(value*item.width/item.height));else s.height=Math.max(1,Math.round(value*item.height/item.width));}
 s.initialized=true;settingsChanged();
}
$('resize-width').oninput=()=>dimensionChanged('width');$('resize-height').oninput=()=>dimensionChanged('height');
$('aspect-lock').onchange=()=>{if(busy||loading)return;const s=settings.resize;s.width=Number($('resize-width').value);s.height=Number($('resize-height').value);s.lock=$('aspect-lock').checked;s.initialized=true;settingsChanged();};
document.querySelectorAll('[data-scale]').forEach(button=>button.onclick=()=>{
 if(busy||loading)return;const item=current();if(!item){toast('请先添加图片');return;}const scale=Number(button.dataset.scale);
 Object.assign(settings.resize,{width:Math.max(1,Math.round(item.width*scale)),height:Math.max(1,Math.round(item.height*scale)),initialized:true});settingsChanged();
});
$('reset-settings').onclick=()=>{
 if(busy||loading)return;settings[mode]={...defaults[mode]};
 if(mode==='resize'&&current())Object.assign(settings.resize,{width:current().width,height:current().height,initialized:true});
 settingsChanged();toast('当前工具的设置已重置');
};
$('preview-original').onclick=()=>{showingResult=false;renderCurrent();};
$('preview-result').onclick=()=>{if(!resultFor(selectedId))return;showingResult=true;renderCurrent();};

// Coordinates use the source image, so editing at any zoom remains accurate.
function paintOverlay(canvas){
 const item=current();if(canvas.hidden||!item)return;const rect=canvas.getBoundingClientRect();if(!rect.width||!rect.height)return;
 const ratio=Math.min(globalThis.devicePixelRatio||1,2),scale=Math.min(ratio,Math.sqrt(8000000/(rect.width*rect.height)));
 canvas.width=Math.max(1,Math.round(rect.width*scale));canvas.height=Math.max(1,Math.round(rect.height*scale));
 const ctx=canvas.getContext('2d');if(!ctx)return;ctx.fillStyle='#172520';
 for(const r of [...item.redactions,...(draft?[draft]:[])])ctx.fillRect(r.x*canvas.width,r.y*canvas.height,r.w*canvas.width,r.h*canvas.height);
}
function paintRedactions(){paintOverlay($('redaction-canvas'));if($('zoom-dialog').open)paintOverlay($('zoom-redaction-canvas'));}
function pointerPosition(e,canvas){const rect=canvas.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(e.clientY-rect.top)/rect.height))};}
function bindOverlay(canvas){
 canvas.onpointerdown=e=>{if(busy||loading||e.button!==0||!current())return;showingResult=false;canvas.setPointerCapture(e.pointerId);dragStart=pointerPosition(e,canvas);draft=null;e.preventDefault();};
 canvas.onpointermove=e=>{if(!dragStart)return;const pos=pointerPosition(e,canvas);draft={x:Math.min(pos.x,dragStart.x),y:Math.min(pos.y,dragStart.y),w:Math.abs(pos.x-dragStart.x),h:Math.abs(pos.y-dragStart.y)};paintRedactions();};
 canvas.onpointerup=e=>{
  if(!dragStart)return;const item=current(),added=!!draft&&draft.w*item.width>=2&&draft.h*item.height>=2;if(added)item.redactions.push({...draft});
  draft=null;dragStart=null;if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);renderAll();
  if(!added&&canvas.id==='redaction-canvas')openZoom();
 };
 canvas.onpointercancel=()=>{dragStart=null;draft=null;paintRedactions();};
}
bindOverlay($('redaction-canvas'));bindOverlay($('zoom-redaction-canvas'));
new ResizeObserver(paintRedactions).observe($('preview-wrap'));new ResizeObserver(paintRedactions).observe($('zoom-content'));
$('preview-image').onload=paintRedactions;$('zoom-image').onload=paintRedactions;
function undoRedaction(){if(busy||loading)return;current()?.redactions.pop();showingResult=false;renderAll();}
function clearRedactions(){if(busy||loading)return;if(current())current().redactions=[];showingResult=false;renderAll();}
$('undo-redaction').onclick=$('zoom-undo').onclick=undoRedaction;$('clear-redactions').onclick=$('zoom-clear').onclick=clearRedactions;
function renderZoom(){
 const item=current();if(!item)return;const output=showingResult?resultFor(item.id):null;
 $('zoom-copy-image').textContent=output?'复制图片':'复制原图';$('zoom-copy-image').disabled=busy||loading||(mode==='redact'&&!output);$('zoom-title').textContent=output?'处理后大图 · '+output.name:'原图大图 · '+item.name;
 $('zoom-image').src=output?.url??item.url;$('zoom-image').alt=output?'处理后放大预览':'原图放大预览';
 const width=output?.width??item.width,base=Math.min(width,Math.max(320,Math.min(1000,window.innerWidth-64)));
 $('zoom-content').style.width=Math.max(80,Math.round(base*zoomScale))+'px';$('zoom-level').textContent=Math.round(base*zoomScale/width*100)+'%';
 const editing=mode==='redact'&&!output;$('zoom-redaction-canvas').hidden=!editing;
 $('zoom-redaction-canvas').style.pointerEvents=editing&&zoomDrawing?'auto':'none';$('zoom-redaction-canvas').style.touchAction=editing&&zoomDrawing?'none':'auto';
 $('zoom-draw').hidden=$('zoom-undo').hidden=$('zoom-clear').hidden=!editing;$('zoom-draw').setAttribute('aria-pressed',String(zoomDrawing));$('zoom-draw').textContent=zoomDrawing?'正在框选 · 切换浏览':'框选打码';
 $('zoom-undo').disabled=$('zoom-clear').disabled=!item.redactions.length;$('zoom-out').disabled=zoomScale<=.25;$('zoom-in').disabled=zoomScale>=8;requestAnimationFrame(paintRedactions);
}
function closeZoom(){if($('zoom-dialog').open){$('zoom-dialog').close();lastFocus?.focus();}dragStart=null;draft=null;}
function openZoom(){if(!current()||busy||loading)return;lastFocus=document.activeElement;zoomScale=1;zoomDrawing=false;if(!$('zoom-dialog').open)$('zoom-dialog').showModal();renderZoom();}
$('zoom-preview').onclick=openZoom;$('preview-image').onclick=openZoom;$('zoom-close').onclick=closeZoom;
 $('preview-image').onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();openZoom();}};
 $('copy-preview-image').onclick=()=>copyCurrentImage($('copy-preview-image'));$('zoom-copy-image').onclick=()=>copyCurrentImage($('zoom-copy-image'));
$('zoom-dialog').addEventListener('close',()=>{dragStart=null;draft=null;lastFocus?.focus();});
$('zoom-out').onclick=()=>{zoomScale=Math.max(.25,zoomScale/1.5);renderZoom();};$('zoom-in').onclick=()=>{zoomScale=Math.min(8,zoomScale*1.5);renderZoom();};
$('zoom-draw').onclick=()=>{zoomDrawing=!zoomDrawing;renderZoom();};
$('zoom-dialog').addEventListener('click',e=>{if(e.target===$('zoom-dialog'))closeZoom();});
async function runBatch(onlyIds=null){
 if(busy||loading||!items.length)return;
 const s={...state()},queue=items.filter(item=>!onlyIds||onlyIds.includes(item.id)).map(item=>({item,signature:fingerprint(item),redactions:item.redactions.map(r=>({...r}))}));
 if(!queue.length)return;
 if(mode==='resize'&&(!Number.isInteger(s.width)||s.width<1||s.width>12000||queue.some(entry=>{const height=s.lock?Math.max(1,Math.round(s.width*entry.item.height/entry.item.width)):s.height;return !Number.isInteger(height)||height<1||height>12000||s.width*height>40000000;}))){feedback('尺寸需要调整',['请输入 1–12000 之间的整数宽高。'],'error');$('resize-width').focus();return;}
 if(mode==='redact'){
  const missing=queue.filter(entry=>!entry.redactions.length);
  if(missing.length){selectedId=missing[0].item.id;showingResult=false;renderAll();feedback('还有 '+missing.length+' 张图片没有框选',missing.map(entry=>entry.item.name+'：请先选择要遮挡的区域。'));$('preview-stage').scrollIntoView({behavior:'smooth',block:'center'});return;}
 }
 const targetBytes=mode==='compress'&&s.strategy==='target'?Math.round(Number(s.target)*(s.unit==='MB'?1024*1024:1024)):undefined;
 if(targetBytes!==undefined&&(!Number.isFinite(targetBytes)||targetBytes<1024||targetBytes>20*1024*1024)){feedback('请检查目标大小',['目标大小需要在 1 KB 到 20 MB 之间。'],'error');$('target-size').focus();return;}
 const options={mode,format:s.format,quality:(mode==='compress'&&s.strategy==='target')?0.95:s.quality/100,targetBytes,allowResize:s.allowResize,shouldCancel:()=>cancelRequested},activeMode=mode;
 busy=true;cancelRequested=false;closeZoom();$('feedback').hidden=true;$('processing-progress').hidden=false;$('cancel-processing').disabled=false;
 $('workbench').setAttribute('aria-busy','true');document.querySelector('.settings').inert=true;document.querySelector('.tool-grid').inert=true;renderAll();
 let completed=0,failed=0;
 try{
  for(let index=0;index<queue.length;index++){
   if(cancelRequested)break;const {item,signature,redactions}=queue[index];
   $('progress-label').textContent='正在处理 '+(index+1)+' / '+queue.length+' · '+item.name;
   $('progress-bar').style.width=index/queue.length*100+'%';$('progress-bar').parentElement.setAttribute('aria-valuenow',String(Math.round(index/queue.length*100)));
   await new Promise(resolve=>setTimeout(resolve,20));
   try{
    const output=await processImage(item,{...options,width:s.width,height:mode==='resize'&&s.lock?Math.max(1,Math.round(s.width*item.height/item.width)):s.height,redactions});
    if(cancelRequested)break;revokeResult(outputs[activeMode].get(item.id));const result={...output,id:item.id,url:URL.createObjectURL(output.blob),signature};outputs[activeMode].set(item.id,result);completed++;publishPublicImage(result);
   }catch(error){
    if(error.name==='AbortError'||error.code==='PROCESS_CANCELLED')break;
    const previous=outputs[activeMode].get(item.id);outputs[activeMode].set(item.id,{...previous,id:item.id,name:previous?.name??item.name,error:error.message,signature:previous?.signature??signature});failed++;
   }
   renderResults();
  }
 }finally{
  busy=false;$('workbench').removeAttribute('aria-busy');document.querySelector('.settings').inert=false;document.querySelector('.tool-grid').inert=false;
  $('processing-progress').hidden=true;showingResult=!!resultFor(selectedId);renderAll();
 }
 const remaining=queue.length-completed-failed;
 if(cancelRequested)feedback('已停止，保留 '+completed+' 张本次结果',[remaining?'还有 '+remaining+' 张未处理，可以再次开始。':'已完成的图片仍可下载。'],'info');
 else if(failed)feedback(completed+' 张完成，'+failed+' 张未成功',['原因已保留在结果列表，可点击“重试未成功图片”。'],'error');
 else if(queue.some(entry=>outputs[activeMode].get(entry.item.id)?.targetMet===false))feedback('部分图片未达到目标大小',['实际大小已列出；可换用 WebP、允许缩小尺寸，或调高目标大小。']);
 else toast(completed+' 张图片已生成，可以下载');
 if(allOutputs().length)$('results').scrollIntoView({behavior:'smooth',block:'nearest'});
}
$('process-button').onclick=()=>runBatch();$('retry-failed').onclick=()=>runBatch(allOutputs().filter(r=>r.error).map(r=>r.id));
$('cancel-processing').onclick=()=>{cancelRequested=true;$('cancel-processing').disabled=true;$('progress-label').textContent='正在停止，已完成的结果会保留…';};
async function downloadAll(){
 if(busy||loading||packing)return;const ready=usableOutputs();if(!ready.length)return;
 try{
  if(ready.length===1)downloadBlob(ready[0].blob,ready[0].name);
  else {packing=true;renderResults();updateButton();downloadBlob(await createZip(ready.map(r=>({name:r.name,blob:r.blob}))),'图片急救站-'+new Date().toISOString().slice(0,10)+'.zip');}
  if(items.some(item=>resultFor(item.id)&&!fresh(item)))toast('包含上次处理结果；重新处理可应用当前设置');
 }catch(error){feedback('下载未完成',[error.message],'error');}finally{packing=false;renderResults();updateButton();}
}
$('download-all').onclick=$('mobile-download-button').onclick=downloadAll;
$('try-sample').onclick=async()=>{
 if(busy||loading)return;const canvas=document.createElement('canvas');canvas.width=1800;canvas.height=1200;const ctx=canvas.getContext('2d');
 if(!ctx){toast('当前浏览器无法生成示例',true);return;}
 const gradient=ctx.createLinearGradient(0,0,1800,1200);gradient.addColorStop(0,'#4ddbb6');gradient.addColorStop(.5,'#4db9db');gradient.addColorStop(1,'#6f4ddb');ctx.fillStyle=gradient;ctx.fillRect(0,0,1800,1200);
 ctx.fillStyle='#ffffff';ctx.globalAlpha=.3;ctx.beginPath();ctx.arc(1420,260,160,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
 ctx.fillStyle='#4d72db';ctx.beginPath();ctx.moveTo(0,1200);ctx.lineTo(480,380);ctx.lineTo(1150,1200);ctx.fill();
 ctx.fillStyle='#4d4fdb';ctx.beginPath();ctx.moveTo(600,1200);ctx.lineTo(1280,530);ctx.lineTo(1800,1200);ctx.fill();
 ctx.fillStyle='#ffffff';ctx.font='bold 96px sans-serif';ctx.fillText('你好，图片急救站',100,1010);ctx.font='38px sans-serif';ctx.fillText('这是一张可以放心试用的示例图片',105,1080);
 try{const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('示例生成失败，请直接选择图片。');await ingest([new File([blob],'示例风景.png',{type:'image/png'})]);}
 catch(error){toast(error.message,true);}finally{canvas.width=0;canvas.height=0;}
};
window.addEventListener('beforeunload',()=>{items.forEach(releaseItem);for(const map of Object.values(outputs))for(const r of map.values())revokeResult(r);});
renderAll();