const $ = id => document.getElementById(id);
const state = {config:null, currentPage:null, selected:null, dragId:null, library:"tags"};
const escapeHtml = value => String(value ?? "").replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[char]));
const api = async (url, options={}) => {
  const response = await fetch(url, {credentials:"include", ...options, headers:{...(options.body ? {"Content-Type":"application/json"} : {}), ...(options.headers || {})}});
  if (response.status === 401) { location.href = "/static/login.html"; throw new Error("Authentication required"); }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof body.detail === "string" ? body.detail : `Request failed (${response.status})`);
  return body;
};
function toast(message, error=false){const el=$("toast");el.textContent=message;el.className=`toast show ${error?"error":""}`;clearTimeout(el.timer);el.timer=setTimeout(()=>el.className="toast",3200)}
function slug(value){return value.toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "item"}
function money(cents){return `$${(Number(cents||0)/100).toFixed(2)}`}
function parseJson(value,label){try{return JSON.parse(value||"{}")}catch{throw new Error(`${label} must contain valid JSON.`)}}
function pageById(id){return state.config.pages.find(row=>row.id===Number(id))}
function buttonById(id){return state.config.buttons.find(row=>row.id===Number(id))}

async function load(){
  const me=await api("/auth/me");
  if(!["ADMIN","MANAGER"].includes(me.role)) throw new Error("Manager access is required.");
  state.config=await api("/pos/admin/config/bootstrap?include_deleted=true");
  const firstActive=state.config.pages.find(page=>page.active);
  state.currentPage=state.currentPage && pageById(state.currentPage)?.active ? state.currentPage : firstActive?.id;
  renderAll();
}
function renderAll(){renderFilters();renderPages();renderCatalog();renderCanvas();renderEditorChoices();if(state.selected){const selected=buttonById(state.selected.id);if(selected){state.selected=selected;fillEditor(selected)}}}
function renderFilters(){
  const pageValue=$("pageFilter").value,tagValue=$("tagFilter").value;
  $("pageFilter").innerHTML='<option value="">All pages</option>'+state.config.pages.map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
  $("tagFilter").innerHTML='<option value="">All tags</option>'+state.config.tags.map(t=>`<option value="${t.id}">${escapeHtml(t.name)}</option>`).join("");
  $("pageFilter").value=pageValue;$("tagFilter").value=tagValue;
  const form=$("buttonForm");
  form.elements.page_id.innerHTML=state.config.pages.filter(p=>p.active).map(p=>`<option value="${p.id}">${escapeHtml(p.name)}</option>`).join("");
}
function renderPages(){
  $("pageTabs").innerHTML=state.config.pages.filter(page=>page.active).map(page=>`<button class="page-tab ${page.id===state.currentPage?"active":""}" data-page="${page.id}" draggable="false">${escapeHtml(page.name)}</button>`).join("");
  const page=pageById(state.currentPage);$("canvasTitle").textContent=page?.name||"Select a page";
}
function filteredButtons(){
  const q=$("searchInput").value.toLowerCase().trim(),page=Number($("pageFilter").value),tag=Number($("tagFilter").value),status=$("statusFilter").value;
  return state.config.buttons.filter(button=>{
    if(q && !`${button.name} ${button.display_name} ${button.internal_key}`.toLowerCase().includes(q)) return false;
    if(page && button.page_id!==page)return false;if(tag&&!button.tag_ids.includes(tag))return false;
    if(status==="active"&&(!button.active||button.deleted_at))return false;
    if(status==="disabled"&&(button.active||button.deleted_at))return false;
    if(status==="deleted"&&!button.deleted_at)return false;return true;
  });
}
function renderCatalog(){
  const rows=filteredButtons();$("buttonCount").textContent=rows.length;
  $("catalogList").innerHTML=rows.map(button=>`<button class="catalog-item ${button.active?"":"disabled"} ${button.deleted_at?"deleted":""} ${state.selected?.id===button.id?"active":""}" data-button="${button.id}"><i class="dot"></i><span><strong>${escapeHtml(button.display_name)}</strong><small>${escapeHtml(button.internal_key)} · ${escapeHtml(pageById(button.page_id)?.name)}</small></span><b>${money(button.price_cents)}</b></button>`).join("")||'<div class="empty-inspector"><p>No buttons match these filters.</p></div>';
}
function buttonStyle(button){const v=button.visual||{};return `background-color:${v.background_color||"#dedede"};color:${v.text_color||"#111111"};font-size:${Number(v.font_size||16)}px;border-style:${v.border_style||"solid"};${v.image_url?`--image:url('${String(v.image_url).replace(/'/g,"%27")}')`:""}`}
function renderCanvas(){
  const canvas=$("posCanvas"),page=pageById(state.currentPage);if(!page){canvas.innerHTML="";return}
  const cells=[];for(let row=1;row<=8;row++)for(let col=1;col<=4;col++)cells.push(`<div class="grid-cell" data-row="${row}" data-col="${col}" style="grid-row:${row};grid-column:${col}"></div>`);
  const buttons=state.config.buttons.filter(b=>b.page_id===page.id&&b.active&&!b.deleted_at).map(button=>{const l=button.layout,v=button.visual||{};return `<button class="pos-button ${v.image_url?"has-image":""}" draggable="true" data-layout-button="${button.id}" style="grid-row:${l.row}/span ${l.height};grid-column:${l.column}/span ${l.width};${buttonStyle(button)}"><span>${escapeHtml(button.display_name)}</span><small>${money(button.price_cents)}</small></button>`}).join("");
  canvas.innerHTML=cells.join("")+buttons;
}
function renderEditorChoices(){
  $("tagChoices").innerHTML=state.config.tags.filter(t=>t.active).map(tag=>`<label><input type="checkbox" name="tag_id" value="${tag.id}"><span>${escapeHtml(tag.name)}</span></label>`).join("")||"<p class='hint'>No tags yet.</p>";
  $("modifierChoices").innerHTML=state.config.modifier_groups.filter(g=>g.active).map(group=>`<label><input type="checkbox" name="modifier_group_id" value="${group.id}"><span><strong>${escapeHtml(group.name)}</strong><small>${group.required?"Required":"Optional"} · ${group.modifiers.length} options</small></span></label>`).join("")||"<p class='hint'>No modifier groups yet.</p>";
  $("promptChoices").innerHTML=state.config.prompts.filter(p=>p.active).map(prompt=>`<label><input type="checkbox" name="prompt_id" value="${prompt.id}"><span><strong>${escapeHtml(prompt.name)}</strong><small>${escapeHtml(prompt.message)}</small></span></label>`).join("")||"<p class='hint'>No prompts yet.</p>";
}
function openEditor(button=null){state.selected=button;$("emptyInspector").classList.add("hidden");$("buttonForm").classList.remove("hidden");$("inspector").classList.add("open");renderCatalog();fillEditor(button)}
function closeEditor(){state.selected=null;$("buttonForm").classList.add("hidden");$("emptyInspector").classList.remove("hidden");$("inspector").classList.remove("open");renderCatalog()}
function fillEditor(button){
  const form=$("buttonForm");form.reset();renderEditorChoices();
  const source=button||{name:"",display_name:"",internal_key:"",price_cents:0,alternate_price_cents:null,page_id:state.currentPage,button_type:"PRODUCT",active:true,layout:{row:1,column:1,width:1,height:1},visual:{},availability:{},routing:{},metadata:{},tag_ids:[],modifier_assignments:[],prompt_assignments:[],ingredients:[]};
  $("editorEyebrow").textContent=button?source.internal_key:"Create product";$("editorTitle").textContent=button?source.display_name:"New button";
  for(const name of ["name","display_name","internal_key","description","button_type","weight_value","weight_unit"])if(form.elements[name])form.elements[name].value=source[name]??"";
  form.elements.price.value=(source.price_cents/100).toFixed(2);form.elements.alternate_price.value=source.alternate_price_cents==null?"":(source.alternate_price_cents/100).toFixed(2);form.elements.page_id.value=source.page_id;form.elements.active.checked=source.active;
  for(const [name,key] of [["grid_row","row"],["grid_column","column"],["grid_width","width"],["grid_height","height"]])form.elements[name].value=source.layout[key];
  const v=source.visual||{};for(const name of ["visual_type","font_size","background_color","text_color","image_url","text_position","border_style"])form.elements[name].value=v[name]??({visual_type:"text",font_size:16,background_color:"#dedede",text_color:"#111111",image_url:"",text_position:"center",border_style:"solid"}[name]);
  form.elements.availability.value=JSON.stringify(source.availability||{},null,2);form.elements.routing.value=JSON.stringify(source.routing||{},null,2);form.elements.metadata.value=JSON.stringify(source.metadata||{},null,2);
  form.querySelectorAll('[name="tag_id"]').forEach(input=>input.checked=source.tag_ids.includes(Number(input.value)));
  form.querySelectorAll('[name="modifier_group_id"]').forEach(input=>input.checked=source.modifier_assignments.some(row=>row.id===Number(input.value)&&!row.disabled));
  form.querySelectorAll('[name="prompt_id"]').forEach(input=>input.checked=source.prompt_assignments.some(row=>row.id===Number(input.value)&&!row.disabled));
  $("deleteButton").classList.toggle("hidden",!button||Boolean(button.deleted_at));$("duplicateButton").classList.toggle("hidden",!button);$("restoreButton").classList.toggle("hidden",!button?.deleted_at);updatePreview();
}
function updatePreview(){const f=$("buttonForm").elements,v={background_color:f.background_color.value,text_color:f.text_color.value,font_size:f.font_size.value,border_style:f.border_style.value,image_url:f.image_url.value};const button=$("buttonPreview");button.classList.toggle("has-image",Boolean(v.image_url));button.setAttribute("style",buttonStyle({visual:v}));button.querySelector("span").textContent=f.display_name.value||"Button";button.querySelector("small").textContent=money(Math.round(Number(f.price.value||0)*100))}
function buttonPayload(){
  const f=$("buttonForm").elements,old=state.selected;
  return {internal_key:f.internal_key.value,name:f.name.value,display_name:f.display_name.value,description:f.description.value||null,category_id:old?.category_id||null,page_id:Number(f.page_id.value),price_cents:Math.round(Number(f.price.value)*100),alternate_price_cents:f.alternate_price.value?Math.round(Number(f.alternate_price.value)*100):null,weight_value:f.weight_value.value?Number(f.weight_value.value):null,weight_unit:f.weight_unit.value||null,button_type:f.button_type.value,active:f.active.checked,availability:parseJson(f.availability.value,"Availability"),visual:{type:f.visual_type.value,visual_type:f.visual_type.value,font_size:Number(f.font_size.value),background_color:f.background_color.value,text_color:f.text_color.value,image_url:f.image_url.value||null,text_position:f.text_position.value,border_style:f.border_style.value},routing:parseJson(f.routing.value,"Kitchen routing"),metadata:parseJson(f.metadata.value,"Metadata"),grid_row:Number(f.grid_row.value),grid_column:Number(f.grid_column.value),grid_width:Number(f.grid_width.value),grid_height:Number(f.grid_height.value),display_order:old?.layout.display_order||0,tag_ids:[...$("buttonForm").querySelectorAll('[name="tag_id"]:checked')].map(x=>Number(x.value)),modifier_groups:[...$("buttonForm").querySelectorAll('[name="modifier_group_id"]:checked')].map((x,i)=>({id:Number(x.value),display_order:i,disabled:false,overrides:{}})),prompts:[...$("buttonForm").querySelectorAll('[name="prompt_id"]:checked')].map((x,i)=>({id:Number(x.value),display_order:i,disabled:false,overrides:{}})),ingredients:old?.ingredients?.map(({ingredient_id,quantity,selection_type,display_order})=>({ingredient_id,quantity,selection_type,display_order}))||[]};
}
async function saveButton(event){event.preventDefault();try{const payload=buttonPayload(),id=state.selected?.id;const saved=await api(id?`/pos/admin/config/buttons/${id}`:"/pos/admin/config/buttons",{method:id?"PUT":"POST",body:JSON.stringify(payload)});toast(id?"Button saved.":"Button created.");state.selected=saved;state.currentPage=saved.page_id;await load()}catch(error){toast(error.message,true)}}
async function deleteSelected(){if(!state.selected||!confirm(`Delete ${state.selected.display_name}? You can restore it later.`))return;try{await api(`/pos/admin/config/buttons/${state.selected.id}`,{method:"DELETE"});toast("Button moved to deleted items.");closeEditor();await load()}catch(error){toast(error.message,true)}}
async function restoreSelected(){try{const saved=await api(`/pos/admin/config/buttons/${state.selected.id}/restore`,{method:"POST"});state.selected=saved;toast("Button restored.");await load()}catch(error){toast(error.message,true)}}
async function duplicateSelected(){try{const saved=await api(`/pos/admin/config/buttons/${state.selected.id}/duplicate`,{method:"POST"});state.selected=saved;toast("Duplicate created.");await load()}catch(error){toast(error.message,true)}}
async function moveButton(buttonId,pageId,row,column){const button=buttonById(buttonId);try{const result=await api("/pos/admin/config/layout",{method:"PUT",body:JSON.stringify({entries:[{button_id:button.id,page_id:pageId,grid_row:row,grid_column:column,grid_width:button.layout.width,grid_height:button.layout.height,display_order:(row-1)*4+column,revision:button.revision}]})});button.page_id=pageId;button.layout={...button.layout,row,column,display_order:(row-1)*4+column};button.revision=result.revisions[String(button.id)];renderAll();toast("Layout saved.")}catch(error){toast(error.message,true);await load()}}

function renderPageManager(){$("pageManager").innerHTML=state.config.pages.map(page=>`<div class="manager-row" data-page-row="${page.id}"><div><input data-field="name" value="${escapeHtml(page.name)}"><small>${escapeHtml(page.slug)}</small></div><input class="order" data-field="display_order" type="number" min="0" value="${page.display_order}"><label><input data-field="active" type="checkbox" ${page.active?"checked":""}> Active</label><button class="secondary compact" data-save-page="${page.id}" type="button">Save</button></div>`).join("")}
async function savePage(id){const page=pageById(id),row=document.querySelector(`[data-page-row="${id}"]`);try{await api(`/pos/admin/config/pages/${id}`,{method:"PUT",body:JSON.stringify({slug:page.slug,name:row.querySelector('[data-field="name"]').value,description:page.description,active:row.querySelector('[data-field="active"]').checked,display_order:Number(row.querySelector('[data-field="display_order"]').value),metadata:page.metadata||{}})});toast("Page saved.");await load();renderPageManager()}catch(error){toast(error.message,true)}}
async function addPage(){const name=prompt("Page name");if(!name)return;try{const page=await api("/pos/admin/config/pages",{method:"POST",body:JSON.stringify({slug:slug(name),name,active:true,display_order:state.config.pages.length,metadata:{}})});state.currentPage=page.id;toast("Page created.");await load();renderPageManager()}catch(error){toast(error.message,true)}}

function renderLibrary(){const rows=state.config[state.library]||[];$("libraryContent").innerHTML=rows.map(row=>`<button class="library-row" data-library-id="${row.id}" type="button"><span><strong>${escapeHtml(row.name)}</strong><small>${escapeHtml(row.slug||row.scope_type||"")}</small></span><span>›</span></button>`).join("")||"<p class='hint'>Nothing configured yet.</p>"}
async function editLibrary(id=null){
  try{
    if(state.library==="tags"){
      const old=id&&state.config.tags.find(x=>x.id===id),name=prompt("Tag name",old?.name||"");if(!name)return;const groupNames=prompt("Inherited modifier groups (comma-separated names)",(old?.modifier_groups||[]).map(a=>state.config.modifier_groups.find(g=>g.id===a.id)?.name).filter(Boolean).join(", "))??"";const groups=groupNames.split(",").map(x=>x.trim().toLowerCase()).filter(Boolean).map((name,i)=>{const g=state.config.modifier_groups.find(x=>x.name.toLowerCase()===name||x.slug===slug(name));if(!g)throw new Error(`Unknown modifier group: ${name}`);return{id:g.id,display_order:i,disabled:false,overrides:{}}});await api(old?`/pos/admin/config/tags/${old.id}`:"/pos/admin/config/tags",{method:old?"PUT":"POST",body:JSON.stringify({slug:old?.slug||slug(name),name,description:old?.description||null,color:old?.color||"#59e3aa",active:true,behavior:old?.behavior||{},modifier_groups:groups,prompts:old?.prompts||[]})});
    }else if(state.library==="modifiers"){
      const old=id&&state.config.modifier_groups.find(x=>x.id===id),name=prompt("Modifier group name",old?.name||"");if(!name)return;const optionText=prompt("Options, one per line. Use Name|price (example: Loaded|1.99)",(old?.modifiers||[]).map(x=>`${x.name}|${(x.price_delta_cents/100).toFixed(2)}`).join("\n"))??"";const modifiers=optionText.split("\n").map((line,i)=>{const [option,price="0"]=line.split("|");return{internal_key:slug(option),name:option.trim(),price_delta_cents:Math.round(Number(price)*100),default_selected:false,active:true,display_order:i,conditional_visibility:{},metadata:{}}}).filter(x=>x.name);const required=confirm("Require a selection from this group?");await api(old?`/pos/admin/config/modifier-groups/${old.id}`:"/pos/admin/config/modifier-groups",{method:old?"PUT":"POST",body:JSON.stringify({slug:old?.slug||slug(name),name,prompt:old?.prompt||`Choose ${name}`,required,minimum_selections:required?1:0,maximum_selections:1,allow_quantities:false,active:true,conditional_visibility:{},metadata:{},modifiers})});
    }else if(state.library==="prompts"){
      const old=id&&state.config.prompts.find(x=>x.id===id),name=prompt("Prompt name",old?.name||"");if(!name)return;const message=prompt("Prompt message",old?.message||name);if(!message)return;await api(old?`/pos/admin/config/prompts/${old.id}`:"/pos/admin/config/prompts",{method:old?"PUT":"POST",body:JSON.stringify({slug:old?.slug||slug(name),name,message,modifier_group_id:old?.modifier_group_id||null,required:old?.required||false,active:true,config:old?.config||{}})});
    }else{
      const old=id&&state.config.rules.find(x=>x.id===id),name=prompt("Rule name",old?.name||"");if(!name)return;const condition=parseJson(prompt("Condition JSON",JSON.stringify(old?.condition||{"tag":"steak"},null,2)),"Condition");const action=parseJson(prompt("Action JSON",JSON.stringify(old?.action||{"open_modifier_group":"steak-temperature"},null,2)),"Action");await api(old?`/pos/admin/config/rules/${old.id}`:"/pos/admin/config/rules",{method:old?"PUT":"POST",body:JSON.stringify({name,scope_type:old?.scope_type||"GLOBAL",scope_id:old?.scope_id||null,condition,action,priority:old?.priority||0,active:true})});
    }
    toast("Behavior library saved.");await load();renderLibrary();
  }catch(error){toast(error.message,true)}
}
function renderAudit(){$("auditList").innerHTML=state.config.audit.map(row=>`<div class="audit-row"><strong>${escapeHtml(row.action.replaceAll("_"," "))}</strong><span>${escapeHtml(row.entity_type)} ${row.entity_id??""}</span><small>${escapeHtml(row.actor_name)} · ${new Date(row.created_at).toLocaleString()}</small></div>`).join("")||"<p>No changes recorded.</p>"}
async function exportConfig(){try{const response=await fetch("/pos/admin/config/export",{credentials:"include"});if(!response.ok)throw new Error("Export failed");const blob=await response.blob(),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="pos-configuration.json";a.click();URL.revokeObjectURL(a.href);toast("Configuration exported.")}catch(error){toast(error.message,true)}}
async function importConfig(file){try{const config=JSON.parse(await file.text()),preview=await api("/pos/admin/config/import",{method:"POST",body:JSON.stringify({config,preview:true})});const summary=Object.entries(preview.summary).map(([k,v])=>`${k}: ${v}`).join("\n");if(!confirm(`Validated configuration:\n${summary}\n\nApply the safe merge now?`))return;const result=await api("/pos/admin/config/import",{method:"POST",body:JSON.stringify({config,preview:false})});toast(`Import applied (${result.applied.pages} pages).`);await load()}catch(error){toast(error.message,true)}finally{$("importFile").value=""}}

$("catalogList").addEventListener("click",e=>{const row=e.target.closest("[data-button]");if(row)openEditor(buttonById(row.dataset.button))});
$("pageTabs").addEventListener("click",e=>{const tab=e.target.closest("[data-page]");if(tab){state.currentPage=Number(tab.dataset.page);renderPages();renderCanvas()}});
$("pageTabs").addEventListener("dragover",e=>{if(e.target.closest("[data-page]"))e.preventDefault()});$("pageTabs").addEventListener("drop",e=>{const tab=e.target.closest("[data-page]");if(tab&&state.dragId){e.preventDefault();moveButton(state.dragId,Number(tab.dataset.page),1,1)}});
$("posCanvas").addEventListener("dragstart",e=>{const b=e.target.closest("[data-layout-button]");if(b){state.dragId=Number(b.dataset.layoutButton);b.classList.add("dragging");e.dataTransfer.effectAllowed="move"}});$("posCanvas").addEventListener("dragend",e=>{e.target.closest("[data-layout-button]")?.classList.remove("dragging");state.dragId=null});
$("posCanvas").addEventListener("dragover",e=>{const cell=e.target.closest(".grid-cell");if(cell){e.preventDefault();cell.classList.add("dragover")}});$("posCanvas").addEventListener("dragleave",e=>e.target.closest(".grid-cell")?.classList.remove("dragover"));$("posCanvas").addEventListener("drop",e=>{const cell=e.target.closest(".grid-cell");if(cell&&state.dragId){e.preventDefault();cell.classList.remove("dragover");moveButton(state.dragId,state.currentPage,Number(cell.dataset.row),Number(cell.dataset.col))}});$("posCanvas").addEventListener("click",e=>{const b=e.target.closest("[data-layout-button]");if(b)openEditor(buttonById(b.dataset.layoutButton))});
[$("searchInput"),$("pageFilter"),$("tagFilter"),$("statusFilter")].forEach(el=>el.addEventListener(el.tagName==="INPUT"?"input":"change",renderCatalog));
$("newButton").addEventListener("click",()=>openEditor());$("closeEditor").addEventListener("click",closeEditor);$("buttonForm").addEventListener("submit",saveButton);$("buttonForm").addEventListener("input",updatePreview);$("deleteButton").addEventListener("click",deleteSelected);$("restoreButton").addEventListener("click",restoreSelected);$("duplicateButton").addEventListener("click",duplicateSelected);
$("editorTabs").addEventListener("click",e=>{const tab=e.target.closest("[data-tab]");if(!tab)return;$("editorTabs").querySelectorAll("button").forEach(x=>x.classList.toggle("active",x===tab));document.querySelectorAll("[data-section]").forEach(x=>x.classList.toggle("hidden",x.dataset.section!==tab.dataset.tab))});
$("managePages").addEventListener("click",()=>{renderPageManager();$("pagesDialog").showModal()});$("pageManager").addEventListener("click",e=>{const b=e.target.closest("[data-save-page]");if(b)savePage(Number(b.dataset.savePage))});$("addPage").addEventListener("click",addPage);
$("manageLibrary").addEventListener("click",()=>{renderLibrary();$("libraryDialog").showModal()});document.querySelector(".dialog-tabs").addEventListener("click",e=>{const b=e.target.closest("[data-library]");if(!b)return;state.library=b.dataset.library;document.querySelectorAll("[data-library]").forEach(x=>x.classList.toggle("active",x===b));renderLibrary()});$("libraryContent").addEventListener("click",e=>{const row=e.target.closest("[data-library-id]");if(row)editLibrary(Number(row.dataset.libraryId))});$("addLibraryItem").addEventListener("click",()=>editLibrary());
$("auditButton").addEventListener("click",()=>{renderAudit();$("auditDialog").showModal()});$("exportButton").addEventListener("click",exportConfig);$("importButton").addEventListener("click",()=>$("importFile").click());$("importFile").addEventListener("change",e=>e.target.files[0]&&importConfig(e.target.files[0]));
load().catch(error=>{toast(error.message,true);$("catalogList").innerHTML=`<div class="empty-inspector"><h2>Unable to load editor</h2><p>${escapeHtml(error.message)}</p></div>`});
