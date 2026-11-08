#!/usr/bin/env node
// DRY-RUN ONLY: retrieves an existing item and calls VerifyAddFixedPriceItem.
// This script intentionally has NO AddFixedPriceItem or EndFixedPriceItem call.
// Required: EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_USER_REFRESH_TOKEN.
const API = "https://api.ebay.com";
const TRADING = API + "/ws/api.dll";
const INVENTORY_SCOPE = API + "/oauth/api_scope/sell.inventory";
const PREFIX = '<?xml version="1.0" encoding="utf-8"?>';
const options = Object.fromEntries(process.argv.slice(2).filter(v => v.startsWith("--")).map(v => {
  const i = v.indexOf("=");
  return [i < 0 ? v.slice(2) : v.slice(2, i), i < 0 ? "true" : v.slice(i + 1)];
}));
const escapeXml = s => String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")
  .replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
function element(xml, name) {
  const m = xml.match(new RegExp("<" + name + "(?:\\s[^>]*)?>[\\s\\S]*?<\\/" + name + ">"));
  return m ? m[0] : "";
}
function value(xml, name) {
  const el = element(xml,name);
  return el ? el.slice(el.indexOf(">")+1, el.lastIndexOf("</")).trim() : "";
}
function errors(xml) {
  return Array.from(xml.matchAll(/<Errors>[\s\S]*?<\/Errors>/g), m => m[0]);
}
function checkRequired(v, label) {
  if (!v) throw Error("Missing " + label);
  return v;
}
async function accessToken(scope) {
  const id=checkRequired(process.env.EBAY_CLIENT_ID,"EBAY_CLIENT_ID");
  const secret=checkRequired(process.env.EBAY_CLIENT_SECRET,"EBAY_CLIENT_SECRET");
  const refresh=checkRequired(process.env.EBAY_USER_REFRESH_TOKEN,"EBAY_USER_REFRESH_TOKEN");
  const form = new URLSearchParams({grant_type:"refresh_token",refresh_token:refresh});
  if (scope) form.set("scope",scope);
  const r=await fetch(API+"/identity/v1/oauth2/token",{
    method:"POST",
    headers:{"Authorization":"Basic "+Buffer.from(id+":"+secret).toString("base64"),
             "Content-Type":"application/x-www-form-urlencoded"},
    body:form.toString()
  });
  const result=await r.json();
  if (!r.ok) {
    console.log(JSON.stringify({mode:scope?"scope-check":"refresh",http:r.status,
      error:result.error||"unknown",description:result.error_description||""},null,2));
    process.exitCode=1;
    return null;
  }
  return result.access_token;
}
async function trading(token,method,inner) {
  const payload=PREFIX+"<"+method+'Request xmlns="urn:ebay:apis:eBLBaseComponents">'+inner+"</"+method+"Request>";
  const r=await fetch(TRADING,{method:"POST",headers:{
    "Content-Type":"text/xml",
    "X-EBAY-API-CALL-NAME":method,
    "X-EBAY-API-SITEID":"0",
    "X-EBAY-API-COMPATIBILITY-LEVEL":"1487",
    "X-EBAY-API-IAF-TOKEN":token
  },body:payload});
  return {http:r.status,xml:await r.text()};
}
function itemSpecifics(xml, brand, type) {
  let specs=element(xml,"ItemSpecifics");
  for (const [name, supplied] of [["Brand",brand],["Type",type]]) {
    if (specs.includes("<Name>"+name+"</Name>")) continue;
    if (!supplied) throw Error("ItemSpecifics lacks "+name+"; provide --"+name.toLowerCase()+"=...");
    const entry="<NameValueList><Name>"+name+"</Name><Value>"+escapeXml(supplied)+"</Value></NameValueList>";
    specs=specs ? specs.replace("</ItemSpecifics>",entry+"</ItemSpecifics>") : "<ItemSpecifics>"+entry+"</ItemSpecifics>";
  }
  return specs;
}
async function main() {
  if (options["check-scope"]==="true") {
    const t=await accessToken(INVENTORY_SCOPE);
    if (t) console.log(JSON.stringify({mode:"scope-check",http:200,
      scope:INVENTORY_SCOPE,accessTokenPresent:true}));
    return;
  }
  const token=await accessToken();
  if (!token) return;
  const itemId=options["source-item"]||"377629558928";
  if (!/^\d+$/.test(itemId)) throw Error("source-item must be numeric");
  const src=await trading(token,"GetItem","<ItemID>"+itemId+
    "</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics>");
  const srcAck=value(src.xml,"Ack");
  if (srcAck!=="Success"&&srcAck!=="Warning") {
    console.log(JSON.stringify({mode:"get-item",http:src.http,ack:srcAck,errors:errors(src.xml)},null,2));
    process.exitCode=1; return;
  }
  const calc=element(src.xml,"CalculatedShippingRate");
  for (const f of ["PackageDepth","PackageLength","PackageWidth","WeightMajor","WeightMinor"]) {
    if (!value(calc,f)) throw Error("Source listing has no usable "+f+"; do not guess shipping size/weight");
  }
  const pkg="<ShippingPackageDetails><MeasurementUnit>English</MeasurementUnit>"+
    ["PackageDepth","PackageLength","PackageWidth","ShippingPackage","WeightMajor","WeightMinor"]
      .map(f=>value(calc,f)?"<"+f+">"+escapeXml(value(calc,f))+"</"+f+">":"").join("")+
    "</ShippingPackageDetails>";
  const url=options["vendor-picture-url"]||value(src.xml,"PictureURL");
  if (!/^https:\/\//i.test(url)) throw Error("A real HTTPS gallery URL is required");
  const pic='<PictureDetails>'+(options["vendor-picture-url"]?
    "<PictureSource>Vendor</PictureSource>":"")+
    "<PictureURL>"+escapeXml(url)+"</PictureURL></PictureDetails>";
  const price=options.price||"99.99";
  if (!/^\d+(\.\d{1,2})?$/.test(price)||Number(price)<=0) throw Error("Invalid positive verification price");
  const title=options.title||"Navy Abstract Wave Triptych - VERIFY ONLY";
  const inner=["<Item>","<Title>"+escapeXml(title)+"</Title>",
    "<Description>Verification-only request; no new item will be posted.</Description>",
    element(src.xml,"PrimaryCategory"),"<StartPrice>"+price+"</StartPrice>",
    "<Quantity>1</Quantity>","<Country>US</Country>","<Currency>USD</Currency>",
    "<ListingType>FixedPriceItem</ListingType>","<ListingDuration>GTC</ListingDuration>",
    element(src.xml,"ConditionID"),element(src.xml,"Location"),element(src.xml,"PostalCode"),
    element(src.xml,"DispatchTimeMax"),pic,element(src.xml,"ShippingDetails"),pkg,
    element(src.xml,"ReturnPolicy"),itemSpecifics(src.xml,options.brand,options.type),"</Item>"].join("");
  const result=await trading(token,"VerifyAddFixedPriceItem",inner);
  const ack=value(result.xml,"Ack");
  console.log(JSON.stringify({mode:"verify-only",http:result.http,ack,
    blockingErrors:errors(result.xml).filter(e=>value(e,"SeverityCode")==="Error").length,
    errors:errors(result.xml),sourceItem:itemId,
    galleryMode:options["vendor-picture-url"]?"vendor-https":"existing-eps-verify-only",
    package:{lb:value(calc,"WeightMajor"),oz:value(calc,"WeightMinor"),
      lengthIn:value(calc,"PackageLength"),widthIn:value(calc,"PackageWidth"),
      depthIn:value(calc,"PackageDepth")}},null,2));
  if (ack!=="Success"&&ack!=="Warning") process.exitCode=1;
}
main().catch(e=>{console.error("Verify failed: "+e.message);process.exitCode=1;});
