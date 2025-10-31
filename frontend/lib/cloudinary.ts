// Upload image to Cloudinary
export const uploadToCloudinary = async (imageBlob: Blob): Promise<string> => {
  const cloudinaryUrl = "https://api.cloudinary.com/v1_1/dbo7hzofg/raw/upload";
  const uploadPreset = "test123";

  const formData = new FormData();
  formData.append('file', imageBlob);
  formData.append('upload_preset', uploadPreset);

  console.log('Uploading image to Cloudinary:', imageBlob.type);

  try {
    const response = await fetch(cloudinaryUrl, {
      method: 'POST',
      body: formData,
    });

    if (!response.ok) {
      throw new Error('Failed to upload image to Cloudinary');
    }

    const result = await response.json();
    console.log('Cloudinary upload successful:', result.secure_url);
    return result.secure_url;
  } catch (error) {
    console.error('Error uploading image to Cloudinary:', error);
    throw error;
  }
};


