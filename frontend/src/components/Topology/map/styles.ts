/** Topology map styles; rendered in a <style> tag only while the map is mounted, since
 * generic class names like .save-btn or .input-field would clash elsewhere. */
export const TOPOLOGY_CSS = `
        .topology-toolbar {
          position: absolute;
          top: 12px;
          left: 12px;
          z-index: 10;
          display: flex;
          gap: 6px;
        }

        .topology-sidebar {
          width: 320px;
          background: var(--bg-surface);
          border-left: 1px solid var(--border-subtle);
          display: flex;
          flex-direction: column;
          animation: slideIn 0.3s ease-out;
          z-index: 100;
        }
        @keyframes slideIn { from { transform: translateX(100%); } to { transform: translateX(0); } }

        .sidebar-header {
          padding: 20px;
          border-bottom: 1px solid rgba(255,255,255,0.05);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .header-title { display: flex; align-items: center; gap: 10px; font-weight: 800; color: #f1f5f9; }
        .close-btn { background: none; border: none; color: #64748b; cursor: pointer; }

        .sidebar-content { padding: 20px; flex: 1; overflow-y: auto; }
        .device-preview, .edge-info {
          display: flex;
          align-items: center;
          gap: 15px;
          padding: 15px;
          background: rgba(255,255,255,0.03);
          border-radius: 12px;
          margin-bottom: 25px;
        }
        .preview-name { font-weight: 700; color: #f8fafc; }
        .preview-ip { font-size: 0.75rem; color: #94a3b8; }
        .preview-type {
          font-size: 0.65rem;
          color: #64748b;
          background: rgba(255,255,255,0.05);
          padding: 2px 6px;
          border-radius: 4px;
          display: inline-block;
          margin-top: 4px;
          font-weight: 700;
        }

        .input-field { margin-bottom: 20px; }
        .input-field label { display: block; font-size: 0.75rem; font-weight: 800; color: #94a3b8; text-transform: uppercase; margin-bottom: 8px; }
        .input-field input, .input-field select {
          width: 100%;
          background: #0f172a;
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          padding: 10px;
          color: #f1f5f9;
          font-size: 0.875rem;
        }

        .sidebar-actions { display: flex; flex-direction: column; gap: 10px; margin-top: 30px; }
        .save-btn {
          width: 100%;
          background: #38bdf8;
          color: #0f172a;
          border: none;
          padding: 12px;
          border-radius: 8px;
          font-weight: 800;
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 8px;
          cursor: pointer;
        }
        .delete-btn {
          width: 100%;
          background: rgba(239, 68, 68, 0.1);
          color: #ef4444;
          border: 1px solid rgba(239, 68, 68, 0.2);
          padding: 10px;
          border-radius: 8px;
          font-size: 0.75rem;
          cursor: pointer;
        }
        .delete-btn.full { font-size: 0.875rem; font-weight: 800; padding: 12px; }

        .topology-node {
          background: rgba(15, 23, 42, 0.98);
          color: #f8fafc;
          border: 1px solid rgba(255,255,255,0.08);
          border-radius: 16px;
          padding: 16px;
          min-width: 240px;
          transition: border-color 0.2s;
          transform: translateZ(0);
        }
        .topology-node.selected {
          border-color: #38bdf8;
          box-shadow: 0 0 20px rgba(56, 189, 248, 0.2);
        }
        .topology-node:hover {
          border-color: rgba(255,255,255,0.2);
        }
        .topology-node.online { border-left: 4px solid #10b981; }
        .topology-node.offline { border-left: 4px solid #ef4444; opacity: 0.8; }
        
        .node-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
        .status-indicator {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          position: absolute;
          bottom: -2px;
          right: -2px;
          border: 2px solid #0f172a;
        }
        .status-indicator.active { background: #10b981; box-shadow: 0 0 8px #10b981; }
        .status-indicator.inactive { background: #ef4444; }

        .node-label { font-weight: 700; font-size: 0.9rem; color: #f8fafc; }
        .node-sublabel { font-size: 0.7rem; color: #94a3b8; font-family: monospace; }
        .node-metrics { display: flex; flex-direction: column; gap: 6px; margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,0.05); }
        .metric-item { display: flex; align-items: center; gap: 8px; font-size: 0.65rem; color: #94a3b8; }
        .metric-bar-bg { flex: 1; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; overflow: hidden; }
        .metric-bar-fill { height: 100%; transition: width 0.3s ease; }
        .metric-bar-fill.cpu { background: #38bdf8; }
        .metric-bar-fill.ram { background: #22d3ee; }
        
        .port-count { font-size: 8px; color: #64748b; margin-top: 10px; display: flex; align-items: center; gap: 4px; font-weight: 700; }

        .node-handle { 
          width: 12px !important; 
          height: 12px !important; 
          background: #38bdf8 !important; 
          border: 3px solid #0f172a !important; 
        }
        .node-handle.target { background: #10b981 !important; }
        .node-handle.source { background: #38bdf8 !important; }
        
        .refresh-btn {
          background: var(--bg-elevated);
          width: 34px;
          height: 34px;
          border-radius: var(--radius-md);
          border: 1px solid var(--border-medium);
          display: flex;
          align-items: center;
          justify-content: center;
          color: var(--text-secondary);
          cursor: pointer;
        }
        .refresh-btn:hover { color: var(--text-primary); }
        .refresh-btn:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
        .refresh-btn.spinning svg { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        @keyframes pulse {
          0%, 100% { opacity: 0.4; transform: scaleY(1); }
          50% { opacity: 1; transform: scaleY(1.2); }
        }
        .node-icon-container { position: relative; }
        .wlan-badge {
          position: absolute;
          top: -4px;
          right: -4px;
          background: #38bdf8;
          color: white;
          border-radius: 50%;
          padding: 2px;
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.5);
        }
        
        .host-badge {
          background: rgba(245, 158, 11, 0.2);
          color: #f59e0b;
          border: 1px solid rgba(245, 158, 11, 0.3);
          padding: 1px 4px;
          border-radius: 4px;
          font-size: 8px;
          font-weight: 900;
          display: flex;
          align-items: center;
          gap: 2px;
        }

        .node-parent-info {
          font-size: 8px;
          color: #94a3b8;
          margin-top: 4px;
          display: flex;
          align-items: center;
          gap: 4px;
          font-weight: 600;
          opacity: 0.8;
        }

        /* A multi-VLAN router stays one node; its further addresses sit on it */
        .node-interfaces {
          display: flex;
          flex-wrap: wrap;
          gap: 3px;
          margin-top: 6px;
        }

        .node-iface {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 1px 6px;
          border-radius: 999px;
          border: 1px solid color-mix(in srgb, var(--net-color) 30%, transparent);
          background: color-mix(in srgb, var(--net-color) 14%, transparent);
          color: #cbd5e1;
          font-family: monospace;
          font-size: 9px;
          line-height: 14px;
        }

        .node-iface.is-offline {
          opacity: 0.6;
        }

        .node-iface--more {
          border-color: rgba(255, 255, 255, 0.08);
          background: rgba(255, 255, 255, 0.04);
          color: #94a3b8;
        }

        .react-flow__edge-path {
          pointer-events: none;
        }
        
        /* Disable heavy effects during interaction */
        .react-flow--dragging .topology-node {
          background: rgba(15, 23, 42, 0.98) !important;
          box-shadow: none !important;
        }
        .react-flow--dragging .react-flow__edge-path.animated {
          animation-play-state: paused;
        }
        .topology-sidebar__section { margin-bottom: 20px; }
        .toggle-group {
          display: flex;
          gap: 8px;
        }
        .toggle-item {
          position: relative;
          flex: 1;
          min-width: 0;
          cursor: pointer;
        }
        /* Visually hidden but still keyboard-focusable (display:none removed it from the tab order) */
        .toggle-item input { position: absolute; width: 1px; height: 1px; opacity: 0; }
        .toggle-content {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          min-height: 36px;
          padding: 8px;
          background: var(--bg-input);
          border: 1px solid var(--border-medium);
          border-radius: var(--radius-md);
          font-size: 0.8125rem;
          color: var(--text-secondary);
          transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
        }
        .toggle-item:hover .toggle-content { color: var(--text-primary); }
        .toggle-item input:checked + .toggle-content {
          background: rgba(61, 184, 245, 0.1);
          border-color: var(--accent-primary);
          color: var(--text-primary);
        }
        .toggle-item input:focus-visible + .toggle-content { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
        .section-label {
          display: block;
          font-size: 0.7rem;
          text-transform: uppercase;
          color: #64748b;
          margin-bottom: 8px;
          font-weight: 700;
        }
        .flow-controls {
          position: absolute;
          top: 12px;
          right: 12px;
          background: var(--bg-elevated);
          border: 1px solid var(--border-medium);
          border-radius: var(--radius-lg);
          padding: 12px;
          width: 180px;
          z-index: 1000;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
          display: flex;
          flex-direction: column;
          gap: 12px;
          transition: all 0.3s ease;
        }
        .flow-controls.collapsed {
          width: 140px;
          gap: 0;
          padding: 10px;
        }
        .flow-controls__header {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 0.8125rem;
          font-weight: 600;
          color: var(--text-primary);
          border-bottom: 1px solid var(--border-subtle);
          padding-bottom: 8px;
        }
        .collapsed .flow-controls__header {
          border-bottom: none;
          padding-bottom: 0;
        }
        .flow-control-item {
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .flow-control-item__label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 0.7rem;
          color: #94a3b8;
          font-weight: 600;
        }
        .flow-control-item input[type="range"] {
          -webkit-appearance: none;
          width: 100%;
          height: 4px;
          background: rgba(255,255,255,0.1);
          border-radius: 2px;
          outline: none;
        }
        .flow-control-item input[type="range"]::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 12px;
          height: 12px;
          background: #38bdf8;
          border-radius: 50%;
          cursor: pointer;
          box-shadow: 0 0 10px rgba(56, 189, 248, 0.5);
        }
        @media (max-width: 768px) {
          .flow-controls {
            top: auto;
            bottom: 12px;
            right: 12px;
          }
          /* The settings panel overlays the map instead of squeezing it next to it */
          .topology-sidebar {
            position: absolute;
            inset: 0;
            width: auto;
            border-left: 0;
          }
        }
        .input-field label { text-transform: none; font-weight: 500; color: var(--text-secondary); }
        .section-label { text-transform: none; font-weight: 500; color: var(--text-secondary); }
        
        /* --- Styled React Flow Controls --- */
        .react-flow__controls {
          display: flex;
          flex-direction: column;
          gap: 6px;
          background: rgba(15, 23, 42, 0.6) !important;
          backdrop-filter: blur(12px) !important;
          padding: 6px !important;
          border-radius: 12px !important;
          border: 1px solid rgba(255, 255, 255, 0.1) !important;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4) !important;
          left: 20px !important;
          bottom: 20px !important;
        }
        .react-flow__controls-button {
          background: rgba(255, 255, 255, 0.03) !important;
          border-bottom: none !important;
          border: 1px solid rgba(255, 255, 255, 0.05) !important;
          border-radius: 8px !important;
          color: #94a3b8 !important;
          width: 32px !important;
          height: 32px !important;
          display: flex !important;
          align-items: center !important;
          justify-content: center !important;
          transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1) !important;
          margin-bottom: 2px !important;
        }
        .react-flow__controls-button:hover {
          background: rgba(56, 189, 248, 0.15) !important;
          color: #38bdf8 !important;
          border-color: rgba(56, 189, 248, 0.4) !important;
          transform: translateY(-2px);
          box-shadow: 0 4px 12px rgba(56, 189, 248, 0.2);
        }
        .react-flow__controls-button svg {
          fill: currentColor !important;
          width: 14px !important;
          height: 14px !important;
        }
        .react-flow__controls-button:active {
          transform: translateY(0) scale(0.95);
        }
      `;
