import { useState } from 'react';
import type { Edge, Node } from 'reactflow';
import { Radio, Save, Settings, Share2, Smartphone, Trash2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeviceIcon } from './DeviceNode';
import { nodeConfigFrom, type NodeConfig } from './graph';

interface TopologySidebarProps {
  selectedNode: Node | null;
  selectedEdge: Edge | undefined;
  onSaveNode: (node: Node, config: NodeConfig) => void;
  onClose: () => void;
  onRotateSpeed: (edgeId: string, currentSpeed: string, forcedSpeed?: string) => void;
  onDeleteLink: (edgeId: string) => void;
}

export function TopologySidebar({ selectedNode, selectedEdge, onSaveNode, onClose, onRotateSpeed, onDeleteLink }: TopologySidebarProps) {
  const { t } = useTranslation();
  return (
    <div className="topology-sidebar">
      <div className="sidebar-header">
        <div className="header-title">
          <Settings size={18} />
          {selectedNode ? t('topology.device_config', 'Device Configuration') : t('topology.connection_info', 'Connection Info')}
        </div>
        <button className="close-btn" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <div className="sidebar-content">
        {selectedNode && <NodeSettings node={selectedNode} onSave={(config) => onSaveNode(selectedNode, config)} />}
        {selectedEdge && <EdgeSettings edge={selectedEdge} onRotateSpeed={onRotateSpeed} onDeleteLink={onDeleteLink} />}
      </div>
    </div>
  );
}

/** Mode, ports and handle directions of one device; starts from the device's stored config. */
function NodeSettings({ node, onSave }: { node: Node; onSave: (config: NodeConfig) => void }) {
  const { t } = useTranslation();
  const [config, setConfig] = useState<NodeConfig>(() => nodeConfigFrom(node));
  const set = <K extends keyof NodeConfig>(key: K, value: NodeConfig[K]) => setConfig((prev) => ({ ...prev, [key]: value }));
  const { data } = node;

  return (
    <div className="settings-group">
      <div className="device-preview">
        <DeviceIcon data={data} size={32} serverColor="text-sky-400" />
        <div>
          <div className="preview-name">{data.label}</div>
          <div className="preview-ip">{data.ip}</div>
          {data.virtual_type && (
            <div className="preview-type">
              {data.virtual_type.toUpperCase()}
            </div>
          )}
        </div>
      </div>

      {/* Own class name: "settings-section" is the two-column layout of the settings page */}
      <div className="topology-sidebar__section">
        <label className="section-label">{t('topology.device_mode', 'Device Mode')}</label>
        <div className="toggle-group">
          <label className="toggle-item">
            <input
              type="checkbox"
              checked={config.isWlan}
              onChange={(e) => set('isWlan', e.target.checked)}
            />
            <div className="toggle-content">
              <Smartphone size={14} />
              <span>{t('editor.wlan_client')}</span>
            </div>
          </label>
          <label className="toggle-item">
            <input
              type="checkbox"
              checked={config.isAp}
              onChange={(e) => set('isAp', e.target.checked)}
            />
            <div className="toggle-content">
              <Radio size={14} />
              <span>{t('editor.access_point')}</span>
            </div>
          </label>
        </div>
      </div>

      <div className="input-field">
        <label>{t('topology.max_ports', 'Max Ports')}</label>
        <input
          type="number"
          value={config.maxPorts}
          onChange={(e) => set('maxPorts', parseInt(e.target.value))}
        />
      </div>

      <div className="input-field">
        <label>{t('topology.top_handle', 'Top Handle')}</label>
        <select value={config.topHandle} onChange={(e) => set('topHandle', e.target.value)}>
          <option value="target">{t('topology.handle_input', 'Input (Target)')}</option>
          <option value="source">{t('topology.handle_output', 'Output (Source)')}</option>
          <option value="both">{t('topology.handle_both', 'Both (Bi-Directional)')}</option>
        </select>
      </div>

      <div className="input-field">
        <label>{t('topology.bottom_handle', 'Bottom Handle')}</label>
        <select value={config.bottomHandle} onChange={(e) => set('bottomHandle', e.target.value)}>
          <option value="source">{t('topology.handle_output', 'Output (Source)')}</option>
          <option value="target">{t('topology.handle_input', 'Input (Target)')}</option>
          <option value="both">{t('topology.handle_both', 'Both (Bi-Directional)')}</option>
        </select>
      </div>

      <div className="sidebar-actions">
        <button className="save-btn" onClick={() => onSave(config)}>
          <Save size={16} /> {t('common.save')}
        </button>
        <button className="delete-btn" onClick={() => data.onDelete(node.id)}>
          <Trash2 size={16} /> {t('topology.remove_device', 'Remove Device')}
        </button>
      </div>
    </div>
  );
}

function EdgeSettings({ edge, onRotateSpeed, onDeleteLink }: {
  edge: Edge;
  onRotateSpeed: TopologySidebarProps['onRotateSpeed'];
  onDeleteLink: TopologySidebarProps['onDeleteLink'];
}) {
  const { t } = useTranslation();
  return (
    <div className="settings-group">
      <div className="edge-info">
        <Share2 size={32} className="text-amber-400" />
        <div>
          <div className="preview-name">Link: {edge.data.link_type}</div>
          <div className="preview-ip">ID: {edge.id}</div>
        </div>
      </div>

      <div className="input-field">
        <label>{t('topology.speed', 'Speed')}</label>
        <select
          value={edge.data.link_type}
          onChange={(e) => onRotateSpeed(edge.id, edge.data.link_type, e.target.value)}
        >
          <option value="100Mb">100 Mb/s</option>
          <option value="1GbE">1 Gb/s (1GbE)</option>
          <option value="2.5GbE">2.5 Gb/s (2.5GbE)</option>
          <option value="10GbE">10 Gb/s (10GbE)</option>
        </select>
      </div>

      <button className="delete-btn full" onClick={() => onDeleteLink(edge.id)}>
        <Trash2 size={16} /> {t('topology.disconnect', 'Disconnect')}
      </button>
    </div>
  );
}
