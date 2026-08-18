# app.js Section Map

> Quick reference for navigating `cloud/src-client/app.js` (~10.5K lines).
> Search for `SECTION N:` to jump to any section.

| # | Section | Lines | Key Functions |
|---|---------|-------|---------------|
| 1 | **State & Constants** | ~15-77 | `state`, `noteEditors`, `fileEditors`, mode flags (`placementMode`, `expandedPaneId`, `quickViewActive`, `mentionModeActive`, `moveModeActive`) |
| 2 | **Shortcut & Navigation Helpers** | ~79-199 | `getNextShortcutNumber()`, `jumpToPane()`, `reassignShortcutNumber()`, `showShortcutAssignPopup()` |
| 3 | **Terminal Output & Deferred Buffering** | ~204-334 | `writeTermOutput()`, `flushDeferredOutputs()`, terminal diagnostic dump (Ctrl+Shift+D) |
| 4 | **Cloud Persistence & Sync** | ~336-430 | `cloudFetch()`, `cloudSaveLayout()`, `cloudDeleteLayout()`, `cloudSaveViewState()`, `cloudSaveNote()` |
| 5 | **Multi-Select & Broadcast** | ~445-497 | `clearMultiSelect()`, `togglePaneSelection()`, `updateBroadcastIndicator()` |
| 6 | **HUD System (Fleet, Agents, Chat)** | ~499-1488 | `createHudContainer()`, `createHud()`, `renderHud()`, `createAgentsHud()`, `renderAgentsHud()`, `createChatHud()`, `applyTerminalTheme()`, `applyDeviceHighlight()` |
| 7 | **Guest Mode & Claude State Tracking** | ~1491-1942 | `showGuestRegisterModal()`, `initGuestNudge()`, `updateClaudeStates()`, `init()` (bootstrap) |
| 8 | **WebSocket Communication** | ~1944-2388 | `connectWebSocket()`, `handleWsMessage()` (giant switch), heartbeat, reconnect logic |
| 9 | **Preferences & Settings Modal** | ~2390-2832 | `getAllPrefs()`, `showSettingsModal()`, `setCanvasBackground()`, `applyTerminalFont()`, theme/font pickers |
| 10 | **WS Helpers & Agent Management** | ~2835-3210 | `sendWs()`, `showRelayNotification()`, `showUpdateToast()`, `triggerAgentUpdate()`, `showAddMachineDialog()`, `updateAgentOverlay()` |
| 11 | **REST-over-WS API & Connection Status** | ~3212-3397 | `agentRequest()`, `pendingRequests`, `updateConnectionStatus()`, `findOnlineAgentForDevice()`, `setDisconnectOverlay()`, `renderOfflinePlaceholder()` |
| 12 | **Pane Creation & Type Registry** | ~3398-4700 | `PANE_TYPES[]`, `loadAgentPanes()`, `createPane()`, `deletePane()`, `createFilePane()`, `createNotePane()`, `createGitGraphPane()`, `createIframePane()`, `createFolderPane()`, `createBeadsPane()`, `createCustomSelect()`, device picker |
| 13 | **Terminal Lifecycle & Pane Rendering** | ~4704-5086 | `attachTerminal()`, `reattachTerminal()`, `renderPane()`, `renderFilePane()`, `getDeviceColor()`, `beadsStatusIcon()`, `claudeSessionBadgeHtml()`, `deviceLabelHtml()` |
| 14 | **Pane-Specific Renderers** | ~5087-6427 | `expandPane()`, `collapsePane()`, `renderNotePane()`, `renderIframePane()`, `renderBeadsPane()`, `renderFolderPane()`, `setupBeadsListeners()`, `setupIframeListeners()`, folder tree view |
| 15 | **Editor & Input Setup** | ~6428-7203 | `setupNoteEditorListeners()`, `setupImageButtonHandlers()`, `setupTextOnlyToggle()`, `setupFileEditorListeners()`, `initTerminal()` (~320 lines) |
| 16 | **Pane Interaction & Layout** | ~7204-8183 | `applyPaneZoom()`, `setupPaneListeners()` (~500 lines), `findSnapTargets()`, `startDrag()`, `startResizeHold()`, snap guides |
| 17 | **Pane Focus & Canvas Navigation** | ~8185-8298 | `focusPane()`, `panToPane()`, `focusTerminalInput()`, `updateCanvasTransform()`, `getQuickViewInfo()` |
| 18 | **Quick View & Mention Mode** | ~8299-8700 | `addQuickViewOverlay()`, `removeQuickViewOverlay()`, `enterMentionMode()`, `exitMentionMode()`, mention stage overlays |
| 19 | **Placement Mode** | ~8702-8953 | `enterPlacementMode()`, `cancelPlacementMode()`, `handlePlacementMouseMove()`, `handlePlacementKeyDown()` |
| 20 | **UI Menus & Toolbar** | ~8954-9405 | `setupAddPaneMenu()`, `setupTutorialMenu()`, `setupToolbarButtons()`, `setupCanvasInteraction()`, `calcMoveModeZoom()` |
| 21 | **Move Mode (WASD Navigation)** | ~9406-9585 | `enterMoveMode()`, `exitMoveMode()`, `moveModeNavigate()`, `findPaneInDirection()` |
| 22 | **Keyboard Shortcuts** | ~9586-9975 | `setupKeyboardShortcuts()`: Tab chords, double-tap Tab, Tab+Scroll pan, Ctrl+Scroll zoom, Escape |
| 23 | **Canvas Event Listeners** | ~9976-10289 | `setupEventListeners()`: mouse/touch handlers, canvas pan, selection rect, pinch zoom, `setZoom()` |
| 24 | **Debug Exports** | ~10297-10344 | `window.TC2_DEBUG`: exposed internals for console debugging |

---

## Cross-Cutting Concerns

These globals/functions are referenced across many sections:

| Name | Defined In | Used By |
|------|-----------|---------|
| `state` (panes, zoom, pan) | S1 | Everywhere |
| `ws` (WebSocket) | S4 | S8, S10, S11, S13 |
| `agents[]` | S4 | S6, S7, S8, S10, S11, S12 |
| `terminals` Map | S3 | S7, S8, S12, S13, S15, S16 |
| `updateCanvasTransform()` | S17 | S2, S16, S19, S21, S22, S23 |
| `focusPane()` | S17 | S2, S12, S16, S21, S22 |
| `cloudSaveLayout()` | S4 | S2, S12, S16 |
| `sendWs()` | S10 | S8, S13, S15, S22 |
| `agentRequest()` | S11 | S6, S10, S12, S14 |
| `renderHud()` | S6 | S7, S8, S10 |

## Line count note

Line numbers in section dividers are approximate and will shift as code is edited.
Search for `SECTION N:` (e.g. `SECTION 12:`) for reliable navigation.
