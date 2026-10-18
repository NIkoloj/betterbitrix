const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const root=path.resolve(__dirname,'..');
const file=path.join(root,'extension/manifest.json');
const manifest=JSON.parse(fs.readFileSync(file,'utf8'));
if(!manifest.key) {
  if(!process.argv.includes('--init')) throw Error('Extension public key is missing. Initialize it once or use the store public key.');
  const pair=crypto.generateKeyPairSync('rsa',{modulusLength:2048});
  manifest.key=pair.publicKey.export({type:'spki',format:'der'}).toString('base64');
}
manifest.version='0.2.0';
fs.writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
const id=crypto.createHash('sha256').update(Buffer.from(manifest.key,'base64')).digest('hex').slice(0,32)
  .replace(/[0-9a-f]/g,value=>String.fromCharCode(97+parseInt(value,16)));
fs.writeFileSync(path.join(root,'extension/identity.json'),JSON.stringify({id,version:manifest.version},null,2)+'\n');
fs.writeFileSync(path.join(root,'Shared/ExtensionIdentity.cs'),`namespace BetterBitrix;\npublic static class ExtensionIdentity { public const string Id = "${id}"; public const string Version = "${manifest.version}"; }\n`);
console.log(`Extension ID: ${id}`);
