/** Lucide upstream SVG nodes, unchanged geometry. See LICENSE and SOURCES.md. */
import React from 'react'
const nodes = {"message-square": [["path", {"d": "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"}]], "hash": [["line", {"x1": "4", "x2": "20", "y1": "9", "y2": "9"}], ["line", {"x1": "4", "x2": "20", "y1": "15", "y2": "15"}], ["line", {"x1": "10", "x2": "8", "y1": "3", "y2": "21"}], ["line", {"x1": "16", "x2": "14", "y1": "3", "y2": "21"}]]}
export function LucideIcon({name,size=18}) {
 return React.createElement('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:2,strokeLinecap:'round',strokeLinejoin:'round','aria-hidden':true,focusable:false,'data-icon-library':'lucide','data-icon':name},
 ...nodes[name].map(([tag,attrs],key)=>React.createElement(tag,{...attrs,key})))
}
