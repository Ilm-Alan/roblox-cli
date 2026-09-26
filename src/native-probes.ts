import type { Json } from './scenario.js';
// Arguments are JSON data, never interpolated as executable Luau.
function args(value: Json): string {
  return `local args = game:GetService("HttpService"):JSONDecode(${JSON.stringify(JSON.stringify(value))})\n`;
}
const UI_HELPERS = String.raw`
local player = game:GetService("Players").LocalPlayer
assert(player, "A play client is required")
local pg = player:WaitForChild("PlayerGui")
local gs = game:GetService("GuiService")
local camera = assert(workspace.CurrentCamera, "Camera missing")
local function resolve(root, path)
 for _,name in ipairs(path) do root = root:FindFirstChild(name); assert(root,"Target path missing: "..name) end
 return root
end
local function visible(node)
 local current=node
 while current and current~=game do
  if current:IsA("GuiObject") and not current.Visible then return false end
  if current:IsA("LayerCollector") and not current.Enabled then return false end
  current=current.Parent
 end
 return true
end
local function rect(node)
 local p,s=node.AbsolutePosition,node.AbsoluteSize
 return {x=p.X,y=p.Y,width=s.X,height=s.Y}
end
local function overlaps(a,b)
 return a.x<b.x+b.width and b.x<a.x+a.width and a.y<b.y+b.height and b.y<a.y+a.height
end
local function blockersAt(point, target, skipCore)
 local result={}
 local function check(root)
  local ok,objects=pcall(function() return root:GetGuiObjectsAtPosition(point.X,point.Y) end)
  if not ok then return end
  for _,object in objects do
   if object==target or (target and object:IsDescendantOf(target)) then break end
   if (not target or not target:IsDescendantOf(object)) and visible(object) and (object.Active or object:IsA("GuiButton") or object:IsA("TextBox")) then
    table.insert(result,object:GetFullName())
   end
  end
 end
 check(pg)
 if not skipCore then check(game:GetService("CoreGui")) end
 return result
end
local function screenPoint(point)
 return point-gs:GetInsetArea(Enum.ScreenInsets.None).Min
end
local function freshFrame()
 local count=0
 local c=game:GetService("RunService").RenderStepped:Connect(function() count+=1 end)
 local deadline=os.clock()+1
 repeat task.wait(.02) until count>=2 or os.clock()>=deadline
 c:Disconnect()
 assert(count>=2,"Client is not rendering fresh frames")
end
`;
export function targetingProbe(item: Json): string {
  return args(item) + UI_HELPERS + String.raw`
freshFrame()
local input=assert(game:GetService("UserInputService"):CreateVirtualInput(),"Native input unavailable")
local target,point,worldPoint
local blockers={}
local activated=false
local connection
local prompt
if args.type=="click_gui" then
 target=resolve(pg,args.path)
 assert(target:IsA("GuiButton"),"Target is not a button")
 assert(visible(target),"Target is hidden")
 assert(target.Active and target.Interactable,"Target is disabled")
 assert(target.AbsoluteSize.X>0 and target.AbsoluteSize.Y>0,"Target has no visible area")
 local ancestor=target.Parent
 local r=rect(target)
 while ancestor and ancestor~=pg do
  if ancestor:IsA("BillboardGui") or ancestor:IsA("SurfaceGui") then
   error("World GUI has no trustworthy screen rectangle; use interact_prompt or click_world")
  end
  if ancestor:IsA("GuiObject") and ancestor.ClipsDescendants then
   local a=rect(ancestor)
   assert(r.x>=a.x and r.y>=a.y and r.x+r.width<=a.x+a.width and r.y+r.height<=a.y+a.height,"Button is clipped by "..ancestor:GetFullName())
  end
  ancestor=ancestor.Parent
 end
 point=target.AbsolutePosition+target.AbsoluteSize/2
 blockers=blockersAt(point,target)
 assert(#blockers==0,"Target covered by: "..table.concat(blockers,", "))
 connection=target.Activated:Connect(function() activated=true end)
elseif args.type=="interact_prompt" then
 prompt=resolve(game,args.path)
 assert(prompt:IsA("ProximityPrompt"),"Target is not a ProximityPrompt")
 assert(prompt.Enabled,"Prompt is disabled")
 assert(prompt.HoldDuration<=60,"Prompt requires an unsupported hold longer than 60 seconds")
 assert(not gs.MenuIsOpen and not game:GetService("UserInputService"):GetFocusedTextBox(),"A menu or text entry currently owns keyboard input")
 target=prompt.Parent
 local root=player.Character and player.Character:FindFirstChild("HumanoidRootPart")
 assert(root,"Character is not ready")
 worldPoint=if target:IsA("Attachment") then target.WorldPosition elseif target:IsA("Model") then target:GetPivot().Position else target.Position
 assert((worldPoint-root.Position).Magnitude<=prompt.MaxActivationDistance,"Prompt is out of range")
 local projected,onScreen=camera:WorldToScreenPoint(worldPoint)
 assert(onScreen and projected.Z>0,"Prompt target is outside the viewport")
 point=Vector2.new(projected.X,projected.Y)
 if prompt.RequiresLineOfSight then
  local rp=RaycastParams.new();rp.FilterType=Enum.RaycastFilterType.Exclude;rp.FilterDescendantsInstances={player.Character}
  local hit=workspace:Raycast(camera.CFrame.Position,worldPoint-camera.CFrame.Position,rp)
  assert(not hit or hit.Instance==target or hit.Instance:IsDescendantOf(target),"Prompt is occluded by world geometry")
 end
 local own=if args.gui_path then resolve(pg,args.gui_path) else nil
 blockers=blockersAt(point,own,true)
 assert(#blockers==0,"Prompt target covered by: "..table.concat(blockers,", "))
 connection=prompt.Triggered:Connect(function() activated=true end)
else
 if args.path then
  target=resolve(game,args.path)
  worldPoint=if target:IsA("Model") then target:GetPivot().Position elseif target:IsA("Attachment") then target.WorldPosition else target.Position
 else worldPoint=Vector3.new(unpack(args.position)) end
 local projected,onScreen=camera:WorldToScreenPoint(worldPoint)
 assert(onScreen and projected.Z>0,"World target is outside the viewport")
 point=Vector2.new(projected.X,projected.Y)
 blockers=blockersAt(point,nil)
 assert(#blockers==0,"World target covered by: "..table.concat(blockers,", "))
 local ray=camera:ScreenPointToRay(point.X,point.Y)
 local rp=RaycastParams.new();rp.FilterType=Enum.RaycastFilterType.Exclude;rp.FilterDescendantsInstances=if player.Character then {player.Character} else {}
 local hit=workspace:Raycast(ray.Origin,ray.Direction*10000,rp)
 if target then assert(hit and (hit.Instance==target or hit.Instance:IsDescendantOf(target)),"World ray hits "..(hit and hit.Instance:GetFullName() or "nothing")) end
 if hit then target=hit.Instance end
end
local at=screenPoint(point)
assert(at.X>=0 and at.Y>=0 and at.X<=camera.ViewportSize.X and at.Y<=camera.ViewportSize.Y,"Target is outside the input viewport")
local key=prompt and prompt.KeyboardKeyCode
local ok,err=pcall(function()
 if prompt then
  assert(key~=Enum.KeyCode.Unknown,"Prompt has no keyboard key")
  input:SendKey(true,key);task.wait(math.min(prompt.HoldDuration+.12,60));input:SendKey(false,key)
 else
  input:SendMousePosition(at);task.wait(.08);input:SendMouseButton(at,Enum.UserInputType.MouseButton1,true);task.wait(.08);input:SendMouseButton(at,Enum.UserInputType.MouseButton1,false)
 end
 if connection then
  local deadline=os.clock()+1
  repeat task.wait(.02) until activated or os.clock()>=deadline
  assert(activated,"Native input was sent but the requested target did not activate; inspect the live state before retrying")
 end
end)
-- Release through the same input source even when target validation fails after press.
pcall(function() if key then input:SendKey(false,key) else input:SendMouseButton(at,Enum.UserInputType.MouseButton1,false) end end)
if connection then connection:Disconnect() end
assert(ok,tostring(err))
return {input_sent=true,activated=if connection then activated else nil,target=target and target:GetFullName(),x=at.X,y=at.Y,coordinate_space="screen_pixels",blockers=blockers,viewport={x=camera.ViewportSize.X,y=camera.ViewportSize.Y},game_result="requires_expect_condition"}
`;
}
export function diagnosticProbe(item: Json): string {
  return args(item) + UI_HELPERS + String.raw`
local checks={};for _,name in ipairs(args.checks or {"ui","readiness","counts"}) do checks[name]=true end
local result={viewport={width=camera.ViewportSize.X,height=camera.ViewportSize.Y},desktop=not game:GetService("UserInputService").TouchEnabled,ui={text_overflow={},clipped_controls={},overlaps={}},prompts={},counts={}}
-- Eval results are truncated past a fixed node budget, so each finding list is
-- capped and the overflow counted instead of risking a truncated verdict.
local LIST_LIMIT=25
local omitted={}
local function add(list,name,item) if #list<LIST_LIMIT then table.insert(list,item) else omitted[name]=(omitted[name] or 0)+1 end end
if checks.ui then
 for _,node in pg:GetDescendants() do
  if node:IsA("GuiObject") and visible(node) and node:FindFirstAncestorWhichIsA("ScreenGui") then
   if (node:IsA("TextLabel") or node:IsA("TextButton")) and node.Text~="" and node.TextTransparency<1 and not node.TextFits then
    add(result.ui.text_overflow,"text_overflow",{path=node:GetFullName(),text=node.Text,rect=rect(node)})
   end
   if node:IsA("GuiButton") and node.Active then
    local r=rect(node);local parent=node.Parent
    while parent and parent~=pg do
     if parent:IsA("GuiObject") and parent.ClipsDescendants then
      local a=rect(parent)
      if r.x<a.x or r.y<a.y or r.x+r.width>a.x+a.width or r.y+r.height>a.y+a.height then
       add(result.ui.clipped_controls,"clipped_controls",{path=node:GetFullName(),clipper=parent:GetFullName(),rect=r});break
      end
     end
     parent=parent.Parent
    end
    local blockers=blockersAt(node.AbsolutePosition+node.AbsoluteSize/2,node)
    if #blockers>0 then add(result.ui.overlaps,"overlaps",{path=node:GetFullName(),blockers=table.move(blockers,1,math.min(#blockers,5),1,{}),blocker_count=#blockers}) end
   end
  end
 end
end
local declared={}
for _,path in ipairs(args.blockers or {}) do
 local ok,node=pcall(resolve,pg,path)
 if ok and node:IsA("GuiObject") and visible(node) then table.insert(declared,{path=node:GetFullName(),rect=rect(node),node=node}) end
end
if checks.prompts or checks.counts then
 local root=player.Character and player.Character:FindFirstChild("HumanoidRootPart")
 for _,node in workspace:GetDescendants() do
  if checks.counts then result.counts[node.ClassName]=(result.counts[node.ClassName] or 0)+1 end
  if checks.prompts and node:IsA("ProximityPrompt") and node.Enabled and root then
   local target=node.Parent
   local point=if target:IsA("Attachment") then target.WorldPosition elseif target:IsA("Model") then target:GetPivot().Position elseif target:IsA("BasePart") then target.Position else nil
   if point and (point-root.Position).Magnitude<=node.MaxActivationDistance then
    local projected,onScreen=camera:WorldToScreenPoint(point)
    add(result.prompts,"prompts",{path=node:GetFullName(),in_range=true,on_screen=onScreen,hold_seconds=node.HoldDuration,key=node.KeyboardKeyCode.Name,anchor={x=projected.X,y=projected.Y},note="Anchor only; custom prompt UI may be positioned elsewhere"})
   end
  end
 end
 for _,gui in pg:GetChildren() do
  if gui:IsA("ScreenGui") and gui.Enabled then
   for _,node in gui:GetDescendants() do
    if node:IsA("GuiButton") and visible(node) then
     for _,blocker in declared do
      if node~=blocker.node and not node:IsDescendantOf(blocker.node) and overlaps(rect(node),blocker.rect) then
       add(result.ui.overlaps,"overlaps",{path=node:GetFullName(),blocker=blocker.path,declared=true})
      end
     end
    end
   end
  end
 end
end
if checks.readiness then
 local attribute=args.readiness_attribute
 result.readiness={attribute=attribute,configured=attribute~=nil,value=attribute and workspace:GetAttribute(attribute),rendering=false}
 local frames=0;local connection=game:GetService("RunService").RenderStepped:Connect(function() frames+=1 end)
 task.wait(.15);connection:Disconnect();result.readiness.rendering=frames>0
end
if checks.performance then
 local before=camera.ViewportSize
 local frames={};local connection=game:GetService("RunService").RenderStepped:Connect(function(dt) table.insert(frames,dt*1000) end)
 task.wait((args.duration_ms or 10000)/1000);connection:Disconnect()
 assert(before==camera.ViewportSize,"Viewport changed during performance sample; discard this sample")
 table.sort(frames)
 local sum=0;for _,ms in frames do sum+=ms end
 result.performance={samples=#frames,mean_ms=if #frames>0 then sum/#frames else nil,p95_ms=frames[math.max(1,math.ceil(#frames*.95))],max_ms=frames[#frames],scope="local Studio sample"}
end
result.passed=#result.ui.text_overflow==0 and #result.ui.clipped_controls==0 and #result.ui.overlaps==0
if result.readiness then result.passed=result.passed and result.readiness.rendering and (not result.readiness.configured or result.readiness.value==true) end
if result.performance then result.passed=result.passed and result.performance.samples>0 end
if next(omitted) then result.omitted=omitted end
return result
`;
}
