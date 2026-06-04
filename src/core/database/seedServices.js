import Service from "../../modules/matchmaking/models/Service.model.js";

const seedServices = async () => {
  try {
    const count = await Service.count();
    if (count === 0) {
      const mockServices = [
        {
          service_code: "PLUMBING",
          name: "Sửa đường ống nước (Plumbing)",
          icon_url: "https://res.cloudinary.com/drp2lh8cp/image/upload/v1/services/plumbing.png",
          is_active: true
        },
        {
          service_code: "ELECTRICAL",
          name: "Sửa chữa điện (Electrical)",
          icon_url: "https://res.cloudinary.com/drp2lh8cp/image/upload/v1/services/electrical.png",
          is_active: true
        },
        {
          service_code: "APPLIANCE_REPAIR",
          name: "Sửa chữa thiết bị điện lạnh/gia dụng (Appliance Repair)",
          icon_url: "https://res.cloudinary.com/drp2lh8cp/image/upload/v1/services/appliance.png",
          is_active: true
        },
        {
          service_code: "HOUSE_CLEANING",
          name: "Dọn dẹp nhà cửa (House Cleaning)",
          icon_url: "https://res.cloudinary.com/drp2lh8cp/image/upload/v1/services/cleaning.png",
          is_active: true
        },
        {
          service_code: "PAINTING",
          name: "Sơn nhà & Chống thấm (Painting & Waterproofing)",
          icon_url: "https://res.cloudinary.com/drp2lh8cp/image/upload/v1/services/painting.png",
          is_active: true
        }
      ];
      await Service.bulkCreate(mockServices);
      console.log("Mock services seeded successfully.");
    } else {
      console.log("Services already exist. Seeding skipped.");
    }
  } catch (error) {
    console.error("Failed to seed services:", error);
  }
};

export default seedServices;
