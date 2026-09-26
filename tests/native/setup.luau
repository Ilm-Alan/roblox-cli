local previous = _G.RobloxCliAcceptance
if previous and previous.cleanup then previous.cleanup() end
local player = game.Players.LocalPlayer
local camera = workspace.CurrentCamera
local state = { clicks = 0, world = 0, prompts = 0, presses = 0, releases = 0 }
local connections = {}
local oldCamera = { kind=camera.CameraType, frame=camera.CFrame, subject=camera.CameraSubject }
local gui = Instance.new('ScreenGui')
gui.Name = 'RobloxCliAcceptance'; gui.IgnoreGuiInset = true; gui.DisplayOrder = 1000000; gui.ResetOnSpawn = false
local button = Instance.new('TextButton')
button.Name='Increment';button.Size=UDim2.fromOffset(200,60);button.Position=UDim2.fromOffset(80,120);button.Text='CLI acceptance';button.Parent=gui
local disabled = button:Clone();disabled.Name='Disabled';disabled.Position=UDim2.fromOffset(80,200);disabled.Interactable=false;disabled.Parent=gui
local overlay = Instance.new('Frame');overlay.Name='Blocker';overlay.Active=true;overlay.Size=button.Size;overlay.Position=button.Position;overlay.ZIndex=20;overlay.Visible=false;overlay.Parent=gui
local clipper=Instance.new('Frame');clipper.Name='Clipper';clipper.Size=UDim2.fromOffset(60,30);clipper.Position=UDim2.fromOffset(80,300);clipper.ClipsDescendants=true;clipper.Visible=false;clipper.Parent=gui
local clipped=button:Clone();clipped.Name='Clipped';clipped.Position=UDim2.fromOffset(0,0);clipped.Parent=clipper
local text=Instance.new('TextLabel');text.Name='Overflow';text.Size=UDim2.fromOffset(10,10);text.Text='This label cannot fit';text.TextSize=30;text.Visible=false;text.Parent=gui
local model=Instance.new('Model');model.Name='RobloxCliAcceptance';model.Parent=workspace
local root=player.Character and player.Character:FindFirstChild('HumanoidRootPart');assert(root,'Character required')
local part=Instance.new('Part');part.Name='Target';part.Anchored=true;part.CanCollide=false;part.Size=Vector3.new(3,3,1);part.CFrame=CFrame.new(root.Position+Vector3.new(0,5,-10));part.Parent=model
local prompt=Instance.new('ProximityPrompt');prompt.Enabled=false;prompt.Name='Prompt';prompt.ActionText='Acceptance';prompt.ObjectText='CLI fixture';prompt.KeyboardKeyCode=Enum.KeyCode.E;prompt.MaxActivationDistance=30;prompt.RequiresLineOfSight=false;prompt.HoldDuration=.2;prompt.Parent=part
camera.CameraType=Enum.CameraType.Scriptable;camera.CFrame=CFrame.lookAt(part.Position+Vector3.new(0,0,12),part.Position)
connections[#connections+1]=game:GetService('RunService').RenderStepped:Connect(function()
 camera.CameraType=Enum.CameraType.Scriptable;camera.CFrame=CFrame.lookAt(part.Position+Vector3.new(0,0,12),part.Position)
end)
gui.Parent=player.PlayerGui
connections[#connections+1]=button.Activated:Connect(function() state.clicks+=1 end)
connections[#connections+1]=prompt.Triggered:Connect(function() state.prompts+=1 end)
connections[#connections+1]=game:GetService('UserInputService').InputBegan:Connect(function(input)
 if input.KeyCode==Enum.KeyCode.P then state.presses+=1 end
 if input.UserInputType==Enum.UserInputType.MouseButton1 then
  local mouse=player:GetMouse();if mouse.Target==part then state.world+=1 end
 end
end)
connections[#connections+1]=game:GetService('UserInputService').InputEnded:Connect(function(input) if input.KeyCode==Enum.KeyCode.P then state.releases+=1 end end)
function state.cleanup()
 for _,connection in connections do connection:Disconnect() end
 gui:Destroy();model:Destroy()
 camera.CameraType=oldCamera.kind;camera.CFrame=oldCamera.frame;camera.CameraSubject=oldCamera.subject
 if _G.RobloxCliAcceptance==state then _G.RobloxCliAcceptance=nil end
end
_G.RobloxCliAcceptance=state
task.delay(600,function() if _G.RobloxCliAcceptance==state then state.cleanup() end end)
return {ready=true,expires_seconds=600}
