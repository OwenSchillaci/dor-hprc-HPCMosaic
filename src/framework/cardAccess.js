// A single predicate for card selection, restoration, adding, and rendering.
export const canAccessCard = (name, config, access) => {
  if (!config || !access) return false;
  if (access.card_access?.[name] === false) return false;
  return !config.requiredCapability || access.capabilities?.[config.requiredCapability] === true;
};
