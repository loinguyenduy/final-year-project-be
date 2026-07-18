const compareMessagePosition = (left, right) => {
  const leftTime = new Date(left.createdAt).getTime();
  const rightTime = new Date(right.createdAt).getTime();
  if (leftTime !== rightTime) return leftTime - rightTime;
  if (String(left.id) === String(right.id)) return 0;
  return String(left.id) < String(right.id) ? -1 : 1;
};

export { compareMessagePosition };
