import React, { useRef, useState } from 'react';
import ReactFlow, { Background, Controls, type Node } from 'reactflow';
import 'reactflow/dist/style.css';
import { Maximize, Minimize, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { DeviceNode } from './map/DeviceNode';
import { FlowSettingsContext, LinkEdge } from './map/LinkEdge';
import { FlowControls, useFlowSettings } from './map/FlowControls';
import { TopologySidebar } from './map/TopologySidebar';
import { useFullscreen, useStickyDrag, useTopologyGraph } from './map/hooks';
import type { NodeConfig } from './map/graph';
import { TOPOLOGY_CSS } from './map/styles';

const nodeTypes = {
  device: DeviceNode,
};

const edgeTypes = {
  custom: LinkEdge,
};

const TopologyMap: React.FC = () => {
  const { t } = useTranslation();
  const graph = useTopologyGraph();
  const flow = useFlowSettings();
  const drag = useStickyDrag({ nodes: graph.nodes, edges: graph.edges, setNodes: graph.setNodes, enabled: flow.stickyDrag });
  const containerRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(containerRef);

  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  // Bumped on every node click so the sidebar form starts again from the clicked node
  const [nodeClicks, setNodeClicks] = useState(0);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const selectedEdge = selectedEdgeId ? graph.edges.find(e => e.id === selectedEdgeId) : undefined;

  // Drop the selection once its link is gone: SQLite reuses the freed id for the next link
  if (selectedEdgeId && !selectedEdge) setSelectedEdgeId(null);

  const clearSelection = () => {
    setSelectedNode(null);
    setSelectedEdgeId(null);
  };

  const saveNode = async (node: Node, config: NodeConfig) => {
    if (await graph.saveNodeSettings(node, config)) setSelectedNode(null);
  };

  return (
    <FlowSettingsContext.Provider value={{ speed: flow.speed, intensity: flow.intensity }}>
      <div
        ref={containerRef}
        style={{
          height: '100%',
          width: '100%',
          // Fill the page's content area; a fixed 750px minimum pushed the controls under
          // the phone's tab bar. Only full screen needs an explicit height.
          minHeight: fullscreen.isFullscreen ? '100vh' : 0,
          position: 'relative',
          background: 'var(--bg-surface)',
          display: 'flex'
        }}
      >

      {/* Main Flow Area */}
      <div style={{ flex: 1, position: 'relative', minWidth: 0 }}>
        <div className="topology-toolbar">
          <button
            type="button"
            className={`refresh-btn ${graph.isRefreshing ? 'spinning' : ''}`}
            onClick={() => graph.fetchData()}
            aria-label={t('topology.refresh')}
            title={t('topology.refresh')}
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="refresh-btn"
            onClick={fullscreen.toggle}
            aria-label={fullscreen.isFullscreen ? t('topology.exit_fullscreen') : t('topology.fullscreen')}
            title={fullscreen.isFullscreen ? t('topology.exit_fullscreen') : t('topology.fullscreen')}
          >
            {fullscreen.isFullscreen ? <Minimize size={15} aria-hidden="true" /> : <Maximize size={15} aria-hidden="true" />}
          </button>
        </div>

        <ReactFlow
          nodes={graph.nodes}
          edges={graph.edges}
          onNodesChange={graph.onNodesChange}
          onEdgesChange={graph.onEdgesChange}
          onConnect={graph.onConnect}
          onNodeClick={(_, node) => {
            setSelectedNode(node);
            setSelectedEdgeId(null);
            setNodeClicks(n => n + 1);
          }}
          onEdgeClick={(_, edge) => {
            setSelectedEdgeId(edge.id);
            setSelectedNode(null);
          }}
          onPaneClick={clearSelection}
          onNodeDragStart={drag.onNodeDragStart}
          onNodeDrag={drag.onNodeDrag}
          onNodeDragStop={drag.onNodeDragStop}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.05}
          maxZoom={4}
        >
          <Background color="#1e293b" gap={32} size={1} />
          <Controls />
        </ReactFlow>

        <FlowControls settings={flow} />
      </div>

      {/* Settings Sidebar */}
      {(selectedNode || selectedEdge) && (
        <TopologySidebar
          key={nodeClicks}
          selectedNode={selectedNode}
          selectedEdge={selectedEdge}
          onSaveNode={saveNode}
          onClose={clearSelection}
          onRotateSpeed={graph.onRotateSpeed}
          onDeleteLink={graph.onDeleteLink}
        />
      )}

      <style>{TOPOLOGY_CSS}</style>
    </div>
    </FlowSettingsContext.Provider>
  );
};

export default TopologyMap;
