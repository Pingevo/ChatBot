const JSONbig = require('json-bigint')({ storeAsString: true });
const body = {
  to_id: BigInt('18683592'),
  message_type: 'text',
  content: { text: 'test' },
  conversation_id: BigInt('80245417614920823'),
};
const str = JSONbig.stringify(body);
console.log('JSON output:', str);
console.log('Has conversation_id as number:', /"conversation_id":80245417614920823/.test(str));
console.log('Has to_id as number:', /"to_id":18683592/.test(str));
