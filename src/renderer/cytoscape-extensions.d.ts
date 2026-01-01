// 类型声明文件，用于 Cytoscape 扩展

declare module 'cytoscape-dagre' {
    import cytoscape from 'cytoscape';
    const dagre: cytoscape.Ext;
    export = dagre;
}

declare module 'cytoscape-cose-bilkent' {
    import cytoscape from 'cytoscape';
    const coseBilkent: cytoscape.Ext;
    export = coseBilkent;
}
