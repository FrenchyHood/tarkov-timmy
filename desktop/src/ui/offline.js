const retry = new URLSearchParams(location.search).get("retry");
const go = () => {
  if (retry && /^https?:\/\//.test(retry)) location.href = retry;
};
document.getElementById("retry").onclick = go;
setTimeout(go, 10000);
