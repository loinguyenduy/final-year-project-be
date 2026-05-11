import crypto from "crypto";

// Function to sort an object by its keys (required for VNPay signature generation)
function sortObject(obj) {
  let sorted = {};
  let str = [];
  let key;
  for (key in obj) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) {
      str.push(encodeURIComponent(key));
    }
  }
  str.sort();
  for (key = 0; key < str.length; key++) {
    sorted[str[key]] = encodeURIComponent(obj[str[key]]).replace(/%20/g, "+");
  }
  return sorted;
}

// Function to get the standard IP Address of the User (required for VNPay)
function getIpAddress(req) {
  let ipAddr =
    req.headers["x-forwarded-for"] ||
    req.connection.remoteAddress ||
    req.socket.remoteAddress ||
    req.connection.socket.remoteAddress;
  if (ipAddr === "::1") {
    ipAddr = "127.0.0.1";
  }
  return ipAddr;
}

export { sortObject, getIpAddress };
