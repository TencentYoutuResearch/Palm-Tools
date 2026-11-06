/** Content identity only: raw arguments/results remain in the controlled session. */
import { createHash } from 'node:crypto'
export function toolObservation(value){
 const encoded=JSON.stringify(value)
 const raw=encoded===undefined?'undefined':encoded
 return {encoding:encoded===undefined?'js_undefined':'json_utf8',sha256:createHash('sha256').update(raw).digest('hex'),bytes:Buffer.byteLength(raw)}
}
