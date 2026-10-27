// Generador local Model 2, nivel L. Elige la versión compacta para facilitar
// el enfoque de las cámaras de teléfono y conserva versión 10 para textos largos.
const multiply=(x,y)=>{let z=0;for(let i=7;i>=0;i--){z=(z<<1)^((z>>>7)*0x11d);z^=((y>>>i)&1)*x;}return z;};
function appendBits(out,value,length){for(let i=length-1;i>=0;i--)out.push((value>>>i)&1);}
function reedSolomon(data,degree){let generator=[1];for(let i=0;i<degree;i++){const next=Array(generator.length+1).fill(0),root=(()=>{let n=1;for(let k=0;k<i;k++)n=multiply(n,2);return n})();for(let j=0;j<generator.length;j++){next[j]^=generator[j];next[j+1]^=multiply(generator[j],root);}generator=next;}const result=[...data,...Array(degree).fill(0)];for(let i=0;i<data.length;i++){const factor=result[i];for(let j=0;j<generator.length;j++)result[i+j]^=multiply(generator[j],factor);}return result.slice(-degree);}
function drawFinder(matrix,reserved,cx,cy){const size=matrix.length;for(let dy=-1;dy<=7;dy++)for(let dx=-1;dx<=7;dx++){const x=cx+dx-3,y=cy+dy-3;if(x<0||y<0||x>=size||y>=size)continue;reserved[y][x]=true;const d=Math.max(Math.abs(dx-3),Math.abs(dy-3));matrix[y][x]=d!==2&&d!==4;}}
function drawAlignment(matrix,reserved,cx,cy){for(let dy=-2;dy<=2;dy++)for(let dx=-2;dx<=2;dx++){const x=cx+dx,y=cy+dy;reserved[y][x]=true;matrix[y][x]=Math.max(Math.abs(dx),Math.abs(dy))!==1;}}
function bchRemainder(value,poly){let v=value;const degree=x=>31-Math.clz32(x);while(degree(v)>=degree(poly))v^=poly<<(degree(v)-degree(poly));return v;}
function createMatrix(text){
  const bytes=Array.from(new TextEncoder().encode(text));
  const version=bytes.length<=53?3:bytes.length<=78?4:bytes.length<=106?5:10;
  if(bytes.length>271)throw new Error('El contenido excede la capacidad del QR.');
  const size=17+4*version,blockLengths=version===3?[55]:version===4?[80]:version===5?[108]:[68,68,69,69],ecPerBlock=version===3?15:version===4?20:version===5?26:18,dataCodewords=blockLengths.reduce((sum,length)=>sum+length,0);
  const bits=[];appendBits(bits,4,4);appendBits(bits,bytes.length,version<10?8:16);for(const byte of bytes)appendBits(bits,byte,8);for(let i=0;i<Math.min(4,dataCodewords*8-bits.length);i++)bits.push(0);while(bits.length%8)bits.push(0);
  const data=[];for(let i=0;i<bits.length;i+=8){let value=0;for(let j=0;j<8;j++)value=(value<<1)|bits[i+j];data.push(value);}for(let pad=0;data.length<dataCodewords;pad++)data.push(pad%2===0?0xec:0x11);
  const blocks=[];let offset=0;for(const length of blockLengths){const chunk=data.slice(offset,offset+length);offset+=length;blocks.push({data:chunk,ec:reedSolomon(chunk,ecPerBlock)});}
  const codewords=[];for(let i=0;i<Math.max(...blockLengths);i++)for(const block of blocks)if(i<block.data.length)codewords.push(block.data[i]);for(let i=0;i<ecPerBlock;i++)for(const block of blocks)codewords.push(block.ec[i]);
  const matrix=Array.from({length:size},()=>Array(size).fill(false)),reserved=Array.from({length:size},()=>Array(size).fill(false));
  drawFinder(matrix,reserved,3,3);drawFinder(matrix,reserved,size-4,3);drawFinder(matrix,reserved,3,size-4);
  for(let i=8;i<size-8;i++){reserved[6][i]=reserved[i][6]=true;matrix[6][i]=matrix[i][6]=i%2===0;}
  const align=version===3?[6,22]:version===4?[6,26]:version===5?[6,30]:[6,28,50];for(let yi=0;yi<align.length;yi++)for(let xi=0;xi<align.length;xi++)if(!((yi===0&&xi===0)||(yi===0&&xi===align.length-1)||(yi===align.length-1&&xi===0)))drawAlignment(matrix,reserved,align[xi],align[yi]);
  const formatData=8,format=(formatData<<10)|bchRemainder(formatData<<10,0x537),masked=format^0x5412,bit=n=>((masked>>>n)&1)!==0;
  for(let i=0;i<=5;i++){reserved[i][8]=true;matrix[i][8]=bit(i);}reserved[7][8]=true;matrix[7][8]=bit(6);reserved[8][8]=true;matrix[8][8]=bit(7);reserved[8][7]=true;matrix[8][7]=bit(8);for(let i=9;i<15;i++){reserved[8][14-i]=true;matrix[8][14-i]=bit(i);}
  for(let i=0;i<8;i++){reserved[8][size-1-i]=true;matrix[8][size-1-i]=bit(i);}for(let i=8;i<15;i++){reserved[size-15+i][8]=true;matrix[size-15+i][8]=bit(i);}reserved[size-8][8]=true;matrix[size-8][8]=true;
  if(version>=7){const versionBits=(version<<12)|bchRemainder(version<<12,0x1f25);for(let i=0;i<18;i++){const dark=((versionBits>>>i)&1)!==0,a=size-11+i%3,b=Math.floor(i/3);reserved[b][a]=reserved[a][b]=true;matrix[b][a]=matrix[a][b]=dark;}}
  let bitIndex=0,up=true;for(let right=size-1;right>=1;right-=2){if(right===6)right=5;for(let vert=0;vert<size;vert++){const y=up?size-1-vert:vert;for(let j=0;j<2;j++){const x=right-j;if(reserved[y][x])continue;const value=bitIndex<codewords.length*8?((codewords[bitIndex>>>3]>>>(7-(bitIndex&7)))&1)!==0:false;matrix[y][x]=value^((x+y)%2===0);bitIndex++;}}up=!up;}
  return matrix;
}
export function qrSvg(text){const matrix=createMatrix(text),quiet=4,size=matrix.length+quiet*2;let path='';for(let y=0;y<matrix.length;y++)for(let x=0;x<matrix.length;x++)if(matrix[y][x])path+=`M${x+quiet} ${y+quiet}h1v1h-1z`;return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#102e25"/></svg>`;}
